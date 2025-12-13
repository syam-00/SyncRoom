import React, { useState, useEffect, useRef, useCallback } from 'react';
import { Play, Pause, SkipForward, Music, Users, Signal, Plus, Upload, Wifi, Clock, Lock, Share2, Check, ListMusic, Music2, Radio, Mic, StopCircle, FileAudio, X, Shield, Key, AlertCircle, Search, Loader2, Github, Linkedin, Instagram, RefreshCw } from 'lucide-react';
import { RoomState, User, Track, PlaybackState, AudioStats } from './types';
import { MockSocket } from './services/mockSocketService';
import { syncManager } from './services/syncManager';
import { storageService } from './services/storageService';
import { musicSearchService } from './services/musicSearchService';
import { Tooltip } from './components/Tooltip';
import { VolumeControl } from './components/VolumeControl';

/**
 * UTILITY: Format seconds to MM:SS
 */
const formatTime = (seconds: number) => {
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  return `${mins}:${secs.toString().padStart(2, '0')}`;
};

export default function App() {
  // --- STATE ---
  const [joined, setJoined] = useState(false);
  const [username, setUsername] = useState('');
  const [roomIdInput, setRoomIdInput] = useState(() => {
      // Generate a random room ID by default or simple one
      return 'ROOM-' + Math.floor(Math.random() * 10000);
  });
  const [currentUser, setCurrentUser] = useState<User | null>(null);
  const [roomState, setRoomState] = useState<RoomState | null>(null);
  const [audioStats, setAudioStats] = useState<AudioStats>({ latency: 0, offset: 0, drift: 0, jitter: 0 });
  const [localProgress, setLocalProgress] = useState(0); // For UI slider
  const [volume, setVolume] = useState(0.7);
  const [muted, setMuted] = useState(false);
  const [showInteractionOverlay, setShowInteractionOverlay] = useState(false);
  const [toastMessage, setToastMessage] = useState<string | null>(null);
  
  // Search State
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<Track[]>([]);
  const [isSearching, setIsSearching] = useState(false);
  const [showSearchResults, setShowSearchResults] = useState(false);
  
  // Mobile & UI State
  const [mobileTab, setMobileTab] = useState<'player' | 'queue' | 'members'>('player');
  const [copied, setCopied] = useState(false);
  const [showBroadcastModal, setShowBroadcastModal] = useState(false);
  const [isRecording, setIsRecording] = useState(false);
  const [recordingTime, setRecordingTime] = useState(0);

  // --- REFS (Audio Engine) ---
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const syncIntervalRef = useRef<number | null>(null);
  const rafRef = useRef<number | null>(null);
  const currentUserIdRef = useRef<string | null>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const recordingIntervalRef = useRef<number | null>(null);
  const toastTimeoutRef = useRef<number | null>(null);
  const searchTimeoutRef = useRef<number | null>(null);
  const searchContainerRef = useRef<HTMLDivElement | null>(null);

  // --- HELPERS ---
  const showToast = (msg: string) => {
      setToastMessage(msg);
      if (toastTimeoutRef.current) clearTimeout(toastTimeoutRef.current);
      toastTimeoutRef.current = window.setTimeout(() => setToastMessage(null), 3000);
  };

  const hasPermission = () => {
      return currentUser && roomState && roomState.playAllowedUserIds.includes(currentUser.id);
  };

  const isAdmin = () => {
      return currentUser && roomState && roomState.adminId === currentUser.id;
  };

  // Click outside to close search results
  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (searchContainerRef.current && !searchContainerRef.current.contains(event.target as Node)) {
        setShowSearchResults(false);
      }
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  // --- INITIALIZATION ---
  useEffect(() => {
    // Setup Audio Element
    const audio = new Audio();
    audio.preload = 'auto';
    audioRef.current = audio;

    // Error handling
    const onError = (e: Event) => {
        console.warn("Audio element error:", audio.error);
    };
    audio.addEventListener('error', onError);

    // Socket Listeners
    MockSocket.on('room:update', (newState: RoomState) => {
      setRoomState(newState);
      handlePlaybackStateChange(newState);
    });

    MockSocket.on('user:joined', ({ user }: any) => {
       if (user.id !== currentUserIdRef.current) {
           showToast(`${user.name} joined`);
       }
    });

    MockSocket.on('user:left', ({ user }: any) => {
       if (user.id !== currentUserIdRef.current) {
           showToast(`${user.name} left`);
       }
    });

    MockSocket.on('sync:pong', (payload: any) => {
      const stats = syncManager.processPong(payload.clientSendTime, payload.serverReceiveTime, payload.serverReplyTime);
      setAudioStats(stats);
    });

    MockSocket.on('play:scheduled', ({ trackId, playAtServerTime, startOffset }: any) => {
      if (!audioRef.current) return;
      
      const serverTime = syncManager.getEstimatedServerTime();
      const delayMs = playAtServerTime - serverTime;
      
      console.log(`[SYNC] Scheduled play in ${delayMs}ms. Offset: ${startOffset}s`);

      if (delayMs <= 20) {
        const driftSeconds = (serverTime - playAtServerTime) / 1000;
        const startPos = Math.max(0, startOffset + driftSeconds);
        playImmediate(startPos);
      } else {
        setTimeout(() => {
          playImmediate(startOffset);
        }, delayMs);
      }
    });

    MockSocket.on('pause:sync', ({ pauseAtServerTime, position }: any) => {
      if (audioRef.current) {
        audioRef.current.pause();
        setLocalProgress(position); 
      }
    });

    MockSocket.on('seek:sync', ({ position, atServerTime }: any) => {
        if (!audioRef.current) return;
        
        const serverTime = syncManager.getEstimatedServerTime();
        const delayMs = atServerTime - serverTime;

        if (delayMs > 20) {
             setTimeout(() => {
                 if(audioRef.current) {
                     audioRef.current.currentTime = position;
                 }
             }, delayMs);
        } else {
             audioRef.current.currentTime = position;
        }
        setLocalProgress(position);
    });

    // Start Sync Loop (Ping)
    syncIntervalRef.current = window.setInterval(() => {
      MockSocket.emit('sync:ping', { clientSendTime: Date.now(), userId: currentUserIdRef.current });
    }, 2000);

    return () => {
      if (syncIntervalRef.current) clearInterval(syncIntervalRef.current);
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      if (audioRef.current) {
        audioRef.current.removeEventListener('error', onError);
        audioRef.current.pause();
        audioRef.current.removeAttribute('src');
        audioRef.current.load();
      }
      if (currentUserIdRef.current) {
          MockSocket.disconnect(currentUserIdRef.current);
      }
    };
  }, []);

  // --- AUDIO LOGIC ---

  const handlePlaybackStateChange = async (newState: RoomState) => {
    if (audioRef.current && newState.currentTrackId) {
       const track = newState.queue.find(t => t.id === newState.currentTrackId);
       
       if (track) {
           let srcToLoad = track.url;

           if (track.type === 'shared-file' && track.fileId) {
               if (audioRef.current.getAttribute('data-track-id') === track.id) {
                   // Already loaded
               } else {
                   try {
                       const blob = await storageService.getFile(track.fileId);
                       if (blob) {
                           srcToLoad = URL.createObjectURL(blob);
                       } else {
                           return;
                       }
                   } catch (e) {
                       return;
                   }
               }
           }

           if (srcToLoad && audioRef.current.getAttribute('data-track-id') !== track.id) {
               audioRef.current.src = srcToLoad;
               audioRef.current.setAttribute('data-track-id', track.id);
               audioRef.current.load();
               
               if (newState.playbackState === PlaybackState.PLAYING && newState.startAtServerTime) {
                   catchUpToLive(newState.startAtServerTime);
               }
           }
       }
    }
  };

  const catchUpToLive = (startAtServerTime: number) => {
      if (!audioRef.current) return;
      
      const serverNow = syncManager.getEstimatedServerTime();
      const elapsed = (serverNow - startAtServerTime) / 1000;
      
      if (elapsed > 0) {
          audioRef.current.currentTime = elapsed;
          
          const playPromise = audioRef.current.play();
          if (playPromise !== undefined) {
            playPromise.catch(error => {
                setShowInteractionOverlay(true);
            });
          }
      }
  };

  const playImmediate = (startTime: number) => {
      if(!audioRef.current) return;
      audioRef.current.currentTime = startTime;
      audioRef.current.play().catch(() => setShowInteractionOverlay(true));
  };

  // --- UI LOOP ---
  useEffect(() => {
      const loop = () => {
          if (audioRef.current && !audioRef.current.paused) {
              setLocalProgress(audioRef.current.currentTime);
          }
          rafRef.current = requestAnimationFrame(loop);
      };
      loop();
      return () => { if(rafRef.current) cancelAnimationFrame(rafRef.current); };
  }, []);
  
  useEffect(() => {
      if(audioRef.current) {
          audioRef.current.volume = muted ? 0 : volume;
      }
  }, [volume, muted]);

  // --- ACTIONS ---

  const handleJoin = async () => {
    if (!username || !roomIdInput) return;
    const cleanRoomId = roomIdInput.trim().toUpperCase();
    const user = await MockSocket.connect(username, cleanRoomId);
    setCurrentUser(user);
    currentUserIdRef.current = user.id;
    setJoined(true);
  };

  const emitCommand = (type: string, payload: any = {}) => {
      if (currentUser) {
          MockSocket.emit(type, { ...payload, userId: currentUser.id });
      }
  };

  const handlePlay = () => { 
      if (hasPermission()) emitCommand('cmd:play'); 
      else showToast("You don't have permission to play.");
  };
  const handlePause = () => { 
      if (hasPermission()) emitCommand('cmd:pause'); 
      else showToast("You don't have permission to pause.");
  };
  const handleNext = () => { 
      if (hasPermission()) emitCommand('cmd:next'); 
      else showToast("You don't have permission to skip.");
  };

  const handleSeek = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (!hasPermission()) {
        showToast("You don't have permission to seek.");
        return;
    }
    const newTime = parseFloat(e.target.value);
    setLocalProgress(newTime);
    emitCommand('cmd:seek', { position: newTime });
  };
  
  const handlePlayTrack = (trackId: string) => {
      if (!hasPermission()) {
          showToast("You don't have permission to play tracks.");
          return;
      }
      emitCommand('cmd:playSpecificTrack', { trackId });
  };

  const handleGrant = (targetUserId: string) => {
      if (isAdmin()) emitCommand('cmd:grantPlay', { targetUserId });
  };

  const handleRevoke = (targetUserId: string) => {
      if (isAdmin()) emitCommand('cmd:revokePlay', { targetUserId });
  };

  const handleShare = () => {
      const url = window.location.href; 
      navigator.clipboard.writeText(url).then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 2000);
      });
  };

  const generateNewRoomId = () => {
      setRoomIdInput('ROOM-' + Math.floor(Math.random() * 10000));
  };

  // --- SEARCH LOGIC ---

  const handleSearchInput = (e: React.ChangeEvent<HTMLInputElement>) => {
      const query = e.target.value;
      setSearchQuery(query);
      setShowSearchResults(true);
      
      if (searchTimeoutRef.current) clearTimeout(searchTimeoutRef.current);
      
      if (!query.trim()) {
          setSearchResults([]);
          setIsSearching(false);
          return;
      }

      setIsSearching(true);
      searchTimeoutRef.current = window.setTimeout(async () => {
          const results = await musicSearchService.searchSongs(query);
          setSearchResults(results);
          setIsSearching(false);
      }, 500); // Debounce
  };

  const handleSearchResultClick = (track: Track) => {
      // 1. Add to Queue
      emitCommand('cmd:addTrack', track);
      
      // 2. Play immediately if allowed
      if (hasPermission()) {
          emitCommand('cmd:playSpecificTrack', { trackId: track.id });
          showToast(`Playing "${track.title}"`);
      } else {
          showToast(`Added "${track.title}" to queue`);
      }
      
      // 3. Reset Search
      setSearchQuery('');
      setSearchResults([]);
      setShowSearchResults(false);
  };

  // --- BROADCAST / UPLOAD LOGIC ---

  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (!file) return;

      const fileId = await storageService.uploadFile(file);
      const tempAudio = new Audio(URL.createObjectURL(file));
      tempAudio.addEventListener('loadedmetadata', () => {
          const duration = tempAudio.duration;
          
          const newTrack: Track = {
            id: Math.random().toString(36).substr(2, 5),
            title: file.name.replace(/\.[^/.]+$/, ""),
            artist: currentUser?.name || 'Unknown',
            url: '',
            fileId: fileId,
            duration: (isFinite(duration) ? duration : 0),
            coverUrl: 'https://picsum.photos/300/300',
            type: 'shared-file'
          };
          
          emitCommand('cmd:addTrack', newTrack);
          setShowBroadcastModal(false);
          setMobileTab('queue');
      });
  };

  const startRecording = async (mode: 'user' | 'display') => {
      try {
          let stream: MediaStream;
          if (mode === 'display') {
              stream = await navigator.mediaDevices.getDisplayMedia({ audio: true, video: true }); 
          } else {
              stream = await navigator.mediaDevices.getUserMedia({ audio: true });
          }

          const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus') ? 'audio/webm;codecs=opus' : 'audio/webm';
          const recorder = new MediaRecorder(stream, { mimeType });
          const chunks: Blob[] = [];

          recorder.ondataavailable = (e) => {
              if (e.data.size > 0) chunks.push(e.data);
          };

          recorder.onstop = async () => {
              const blob = new Blob(chunks, { type: mimeType });
              const fileId = await storageService.uploadFile(blob);
              
              const newTrack: Track = {
                id: Math.random().toString(36).substr(2, 5),
                title: mode === 'display' ? `System Audio (${new Date().toLocaleTimeString()})` : `Voice Note (${new Date().toLocaleTimeString()})`,
                artist: currentUser?.name || 'Unknown',
                url: '',
                fileId: fileId,
                duration: recordingTime, // Estimate
                coverUrl: mode === 'display' ? 'https://picsum.photos/seed/sys/300/300' : 'https://picsum.photos/seed/mic/300/300',
                type: 'shared-file'
              };
              
              emitCommand('cmd:addTrack', newTrack);
              
              stream.getTracks().forEach(t => t.stop());
              setIsRecording(false);
              setRecordingTime(0);
              setShowBroadcastModal(false);
              setMobileTab('queue');
          };

          recorder.start();
          mediaRecorderRef.current = recorder;
          setIsRecording(true);
          
          const startTime = Date.now();
          recordingIntervalRef.current = window.setInterval(() => {
              setRecordingTime((Date.now() - startTime) / 1000);
          }, 100);

      } catch (err) {
          console.error("Recording failed", err);
          alert("Could not start recording. Permission denied or not supported.");
      }
  };

  const stopRecording = () => {
      if (mediaRecorderRef.current && mediaRecorderRef.current.state !== 'inactive') {
          mediaRecorderRef.current.stop();
          if (recordingIntervalRef.current) clearInterval(recordingIntervalRef.current);
      }
  };


  // --- VIEWS ---

  if (!joined) {
    return (
      <div className="min-h-screen flex flex-col items-center justify-center bg-gray-900 p-4 relative overflow-hidden">
        {/* Background Animation */}
        <div className="absolute inset-0 z-0">
             <div className="absolute top-1/4 left-1/4 w-96 h-96 bg-purple-600/20 rounded-full blur-3xl animate-pulse"></div>
             <div className="absolute bottom-1/4 right-1/4 w-96 h-96 bg-cyan-600/20 rounded-full blur-3xl animate-pulse" style={{animationDelay: '1s'}}></div>
        </div>

        <div className="z-10 bg-gray-800/80 backdrop-blur-md p-8 rounded-2xl shadow-2xl w-full max-w-md border border-gray-700">
          <div className="flex justify-center mb-6">
            <div className="w-16 h-16 bg-gradient-to-tr from-cyan-500 to-purple-500 rounded-xl flex items-center justify-center shadow-lg transform rotate-3 hover:rotate-6 transition-transform">
               <Music size={32} className="text-white" />
            </div>
          </div>
          <h1 className="text-3xl font-bold text-center mb-2 bg-gradient-to-r from-cyan-400 to-purple-400 bg-clip-text text-transparent">SyncRoom</h1>
          <p className="text-gray-400 text-center mb-8">Listen together, in perfect sync.</p>
          
          <div className="space-y-4">
            <div>
              <label className="block text-sm font-medium text-gray-400 mb-1">Display Name</label>
              <input 
                type="text" 
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                placeholder="Enter your name"
                className="w-full bg-gray-900 border border-gray-700 text-white rounded-lg p-3 focus:ring-2 focus:ring-cyan-500 focus:outline-none transition-all"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-400 mb-1">Room ID</label>
              <div className="relative flex gap-2">
                <div className="relative flex-1">
                    <input 
                      type="text" 
                      value={roomIdInput}
                      onChange={(e) => setRoomIdInput(e.target.value)}
                      placeholder="Enter Room ID"
                      className="w-full bg-gray-900 border border-gray-700 text-white rounded-lg p-3 pl-10 focus:ring-2 focus:ring-cyan-500 focus:outline-none transition-all font-mono tracking-wider uppercase"
                    />
                    <Lock size={16} className="absolute left-3 top-3.5 text-gray-500" />
                </div>
                <button 
                    onClick={generateNewRoomId} 
                    className="bg-gray-700 hover:bg-gray-600 text-white p-3 rounded-lg transition-colors"
                    title="Generate New Room ID"
                >
                    <RefreshCw size={20} />
                </button>
              </div>
              <p className="text-xs text-gray-500 mt-1">Create a new room or enter an existing ID to join friends.</p>
            </div>
            <button 
              onClick={handleJoin}
              disabled={!username || !roomIdInput}
              className="w-full bg-gradient-to-r from-cyan-600 to-purple-600 hover:from-cyan-500 hover:to-purple-500 text-white font-bold py-3 rounded-lg transition-all transform hover:scale-[1.02] disabled:opacity-50 disabled:cursor-not-allowed shadow-lg"
            >
              Join Room
            </button>
          </div>
        </div>
        
        {/* FOOTER */}
        <footer className="absolute bottom-6 w-full text-center z-20">
            <div className="flex justify-center items-center gap-6 text-gray-500 mb-2">
                <a href="https://github.com/syam-00" target="_blank" rel="noreferrer" className="flex items-center gap-2 hover:text-cyan-400 transition-colors group">
                    <Github size={18} className="group-hover:scale-110 transition-transform" />
                    <span className="text-sm font-medium hidden sm:inline">syam-00</span>
                </a>
                <a href="https://www.linkedin.com/in/syam-siddu-b00406312" target="_blank" rel="noreferrer" className="flex items-center gap-2 hover:text-cyan-400 transition-colors group">
                    <Linkedin size={18} className="group-hover:scale-110 transition-transform" />
                    <span className="text-sm font-medium hidden sm:inline">SyamSiddu</span>
                </a>
                <a href="https://instagram.com/mr__.sidduu" target="_blank" rel="noreferrer" className="flex items-center gap-2 hover:text-cyan-400 transition-colors group">
                    <Instagram size={18} className="group-hover:scale-110 transition-transform" />
                    <span className="text-sm font-medium hidden sm:inline">@mr_.sidduu</span>
                </a>
            </div>
            <p className="text-xs text-gray-600">Created by SyamSiddu</p>
        </footer>
      </div>
    );
  }

  const currentTrack = roomState?.queue.find(t => t.id === roomState.currentTrackId);
  const isAllowedToControl = hasPermission();

  return (
    <div className="h-screen flex flex-col bg-gray-900 text-white font-sans overflow-hidden relative">
      
      {/* Toast Notification */}
      {toastMessage && (
          <div className="fixed top-20 left-1/2 -translate-x-1/2 z-50 bg-cyan-900/90 text-white px-6 py-3 rounded-full shadow-xl flex items-center gap-3 animate-in fade-in slide-in-from-top-4 backdrop-blur-sm border border-cyan-500/50">
              <AlertCircle size={20} />
              <span className="font-medium">{toastMessage}</span>
          </div>
      )}

      {/* Interaction Overlay for Autoplay Policy */}
      {showInteractionOverlay && (
          <div className="fixed inset-0 z-50 bg-black/80 backdrop-blur-sm flex items-center justify-center">
              <div className="text-center">
                  <h2 className="text-xl font-bold mb-4">Click to Sync Audio</h2>
                  <button 
                    onClick={() => {
                        if(audioRef.current) {
                            audioRef.current.play();
                            setShowInteractionOverlay(false);
                        }
                    }}
                    className="w-16 h-16 bg-white rounded-full flex items-center justify-center text-black hover:scale-110 transition-transform"
                  >
                      <Play size={32} fill="currentColor" />
                  </button>
              </div>
          </div>
      )}

      {/* Broadcast / Upload Modal */}
      {showBroadcastModal && (
          <div className="fixed inset-0 z-50 bg-black/80 backdrop-blur-sm flex items-center justify-center p-4">
              <div className="bg-gray-800 rounded-2xl max-w-md w-full p-6 border border-gray-700 shadow-2xl relative">
                  <button onClick={() => { if(!isRecording) setShowBroadcastModal(false) }} className="absolute top-4 right-4 text-gray-400 hover:text-white">
                      <X size={20} />
                  </button>

                  <h2 className="text-xl font-bold mb-6 flex items-center gap-2">
                      <Radio className="text-cyan-400" /> 
                      Detect & Broadcast
                  </h2>
                  
                  {isRecording ? (
                      <div className="flex flex-col items-center py-8">
                          <div className="w-20 h-20 bg-red-500/20 rounded-full flex items-center justify-center mb-4 animate-pulse">
                              <Mic size={40} className="text-red-500" />
                          </div>
                          <p className="text-lg font-mono mb-6 text-red-400">{formatTime(recordingTime)}</p>
                          <button 
                              onClick={stopRecording}
                              className="bg-red-600 hover:bg-red-700 text-white font-bold py-3 px-8 rounded-full flex items-center gap-2 transition-transform hover:scale-105"
                          >
                              <StopCircle size={20} /> Stop & Broadcast
                          </button>
                      </div>
                  ) : (
                      <div className="space-y-4">
                          <button 
                              onClick={() => startRecording('display')}
                              className="w-full bg-gray-700 hover:bg-gray-600 p-4 rounded-xl flex items-center gap-4 transition-colors text-left group"
                          >
                              <div className="w-10 h-10 bg-purple-500/20 rounded-lg flex items-center justify-center group-hover:bg-purple-500/30 transition-colors">
                                  <Radio className="text-purple-400" />
                              </div>
                              <div>
                                  <div className="font-bold">Capture System Audio</div>
                                  <div className="text-xs text-gray-400">Record tab/window audio and broadcast</div>
                              </div>
                          </button>

                          <button 
                              onClick={() => startRecording('user')}
                              className="w-full bg-gray-700 hover:bg-gray-600 p-4 rounded-xl flex items-center gap-4 transition-colors text-left group"
                          >
                              <div className="w-10 h-10 bg-red-500/20 rounded-lg flex items-center justify-center group-hover:bg-red-500/30 transition-colors">
                                  <Mic className="text-red-400" />
                              </div>
                              <div>
                                  <div className="font-bold">Record Microphone</div>
                                  <div className="text-xs text-gray-400">Record voice note or nearby audio</div>
                              </div>
                          </button>

                          <div className="relative">
                              <input type="file" id="modal-file-upload" className="hidden" accept="audio/*" onChange={handleFileUpload} />
                              <label 
                                  htmlFor="modal-file-upload"
                                  className="w-full bg-gray-700 hover:bg-gray-600 p-4 rounded-xl flex items-center gap-4 transition-colors text-left cursor-pointer group"
                              >
                                  <div className="w-10 h-10 bg-green-500/20 rounded-lg flex items-center justify-center group-hover:bg-green-500/30 transition-colors">
                                      <FileAudio className="text-green-400" />
                                  </div>
                                  <div>
                                      <div className="font-bold">Upload Audio File</div>
                                      <div className="text-xs text-gray-400">Broadcast a local MP3/WAV file</div>
                                  </div>
                              </label>
                          </div>
                      </div>
                  )}
              </div>
          </div>
      )}

      {/* --- TOP BAR --- */}
      <header className="h-16 border-b border-gray-800 bg-gray-900/90 backdrop-blur flex items-center justify-between px-6 shrink-0 z-20 gap-4">
        {/* Logo Section */}
        <div className="flex items-center gap-4 shrink-0">
            <div className="w-10 h-10 bg-gradient-to-br from-cyan-500 to-purple-600 rounded-lg flex items-center justify-center">
                <Music size={20} className="text-white" />
            </div>
            <div className="hidden sm:block">
                <h1 className="font-bold text-lg leading-tight">{roomState?.name || 'Loading...'}</h1>
                <div className="flex items-center gap-2 text-xs text-gray-400">
                    <span className="bg-gray-800 px-1.5 py-0.5 rounded border border-gray-700 font-mono tracking-wider">ID: {roomState?.id}</span>
                </div>
            </div>
        </div>

        {/* Search Bar */}
        <div className="flex-1 max-w-xl relative group z-30" ref={searchContainerRef}>
            <div className="relative">
                <Search className="absolute left-3 top-2.5 text-gray-500" size={18}/>
                <input 
                    type="text"
                    value={searchQuery}
                    onChange={handleSearchInput}
                    onFocus={() => setShowSearchResults(true)}
                    className="w-full bg-gray-800 border border-transparent focus:border-cyan-500 rounded-full py-2 pl-10 pr-10 text-sm focus:outline-none focus:ring-1 focus:ring-cyan-500 transition-all placeholder-gray-500" 
                    placeholder="Search songs to play..." 
                />
                {isSearching && (
                    <div className="absolute right-3 top-2.5 animate-spin">
                        <Loader2 size={18} className="text-cyan-500" />
                    </div>
                )}
                {!isSearching && searchQuery && (
                     <button onClick={() => { setSearchQuery(''); setSearchResults([]); }} className="absolute right-3 top-2.5 text-gray-500 hover:text-white">
                         <X size={16} />
                     </button>
                )}
            </div>

            {/* Search Results Dropdown */}
            {showSearchResults && searchQuery && (
                <div className="absolute top-full mt-2 w-full bg-gray-800 rounded-xl shadow-2xl border border-gray-700 overflow-hidden max-h-96 overflow-y-auto">
                    {searchResults.length > 0 ? (
                        <ul>
                            {searchResults.map((track) => (
                                <li 
                                    key={track.id}
                                    onClick={() => handleSearchResultClick(track)}
                                    className="p-3 hover:bg-gray-700 cursor-pointer flex items-center gap-3 transition-colors border-b border-gray-700/50 last:border-0"
                                >
                                    <img src={track.coverUrl} className="w-10 h-10 rounded object-cover bg-gray-900" alt="" />
                                    <div className="flex-1 min-w-0">
                                        <div className="text-sm font-bold text-white truncate">{track.title}</div>
                                        <div className="text-xs text-gray-400 truncate">{track.artist}</div>
                                    </div>
                                    <div className="text-cyan-400 opacity-0 group-hover:opacity-100">
                                        <Play size={16} />
                                    </div>
                                </li>
                            ))}
                        </ul>
                    ) : (
                        !isSearching && (
                            <div className="p-4 text-center text-gray-500 text-sm">
                                No songs found for "{searchQuery}"
                            </div>
                        )
                    )}
                </div>
            )}
        </div>

        {/* Right Actions */}
        <div className="flex items-center gap-4 shrink-0">
            <div className="hidden md:flex items-center gap-4">
                <Tooltip text={`Latency: ${audioStats.latency}ms | Jitter: ${audioStats.jitter}ms`}>
                     <div className="flex items-center gap-1 text-xs text-gray-500 cursor-help">
                        <Signal size={14} className={audioStats.latency < 100 ? 'text-green-500' : 'text-yellow-500'} />
                     </div>
                </Tooltip>
            </div>
            
            <button 
                onClick={handleShare}
                className={`hidden sm:flex items-center gap-2 px-4 py-1.5 rounded-full text-sm font-medium transition-all border ${copied ? 'bg-green-900/30 border-green-600 text-green-400' : 'bg-gray-800 hover:bg-gray-700 text-white border-gray-700'}`}
            >
                {copied ? <Check size={14} /> : <Share2 size={14} />}
                {copied ? 'Copied' : 'Share'}
            </button>
        </div>
      </header>

      {/* --- MAIN CONTENT --- */}
      <div className="flex-1 flex min-h-0 relative">
        
        {/* LEFT: Members */}
        <aside className={`
            border-r border-gray-800 flex-col
            ${mobileTab === 'members' ? 'flex absolute inset-0 z-20 w-full bg-gray-900' : 'hidden'}
            md:flex md:static md:w-64 md:inset-auto md:bg-gray-900/50 md:z-auto
        `}>
            <div className="p-4 border-b border-gray-800">
                <h2 className="text-xs font-bold text-gray-500 uppercase tracking-wider flex items-center gap-2">
                    <Users size={14} /> Members ({roomState?.users.length})
                </h2>
            </div>
            <div className="flex-1 overflow-y-auto p-4 space-y-3">
                {roomState?.users.map(u => {
                    const isUserAdmin = roomState.adminId === u.id;
                    const canPlay = roomState.playAllowedUserIds.includes(u.id);
                    
                    return (
                        <div key={u.id} className="flex items-center gap-3 p-2 hover:bg-gray-800 rounded-lg transition-colors group">
                            <img src={u.avatar} alt={u.name} className="w-8 h-8 rounded-full bg-gray-700" />
                            <div className="flex-1 min-w-0">
                                <div className="text-sm font-medium truncate flex items-center gap-1">
                                    {u.name}
                                    {isUserAdmin && <Shield size={12} className="text-purple-400" />}
                                    {!isUserAdmin && canPlay && <Key size={12} className="text-cyan-400" />}
                                </div>
                            </div>
                            
                            {/* Actions for Admin */}
                            {isAdmin() && !isUserAdmin && (
                                <button 
                                    onClick={(e) => { e.stopPropagation(); canPlay ? handleRevoke(u.id) : handleGrant(u.id); }}
                                    className={`p-1.5 rounded transition-colors ${canPlay ? 'hover:bg-red-900/50 text-gray-500 hover:text-red-400' : 'hover:bg-green-900/50 text-gray-600 hover:text-green-400'}`}
                                    title={canPlay ? "Revoke Play Access" : "Grant Play Access"}
                                >
                                    {canPlay ? <X size={14} /> : <Key size={14} />}
                                </button>
                            )}
                            
                            {u.id === currentUser?.id && <div className="w-2 h-2 rounded-full bg-green-500" />}
                        </div>
                    );
                })}
            </div>
        </aside>

        {/* CENTER: Player */}
        <main className={`
            flex-1 flex-col items-center justify-center p-8 relative
            ${mobileTab === 'player' ? 'flex' : 'hidden'}
            md:flex
        `}>
             <div className="absolute inset-0 overflow-hidden pointer-events-none">
                 <div className={`absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[500px] h-[500px] bg-cyan-600/10 rounded-full blur-[100px] transition-opacity duration-1000 ${roomState?.playbackState === PlaybackState.PLAYING ? 'opacity-100' : 'opacity-30'}`}></div>
             </div>

             <div className="relative z-10 w-full max-w-2xl flex flex-col items-center">
                 {/* Album Art */}
                 <div className="relative group">
                     <div className={`absolute -inset-1 bg-gradient-to-r from-cyan-600 to-purple-600 rounded-2xl blur opacity-25 group-hover:opacity-50 transition duration-1000 group-hover:duration-200 ${roomState?.playbackState === PlaybackState.PLAYING ? 'animate-pulse-ring' : ''}`}></div>
                     <img 
                        src={currentTrack?.coverUrl || "https://picsum.photos/400/400"} 
                        alt="Album Art" 
                        className="relative w-64 h-64 md:w-80 md:h-80 rounded-2xl shadow-2xl object-cover mb-8 border border-gray-700"
                     />
                 </div>

                 {/* Track Info */}
                 <div className="text-center mb-8">
                     <h2 className="text-3xl font-bold text-white mb-2">{currentTrack?.title || "No Track Selected"}</h2>
                     <p className="text-lg text-gray-400">{currentTrack?.artist || "Unknown Artist"}</p>
                 </div>

                 {/* Progress Bar */}
                 <div className="w-full mb-6">
                    <input 
                        type="range"
                        min="0"
                        max={currentTrack?.duration || 100}
                        value={localProgress}
                        onChange={handleSeek}
                        disabled={!isAllowedToControl}
                        className={`w-full h-1.5 bg-gray-700 rounded-lg appearance-none cursor-pointer accent-cyan-500 hover:accent-cyan-400 ${!isAllowedToControl ? 'cursor-not-allowed accent-gray-600' : ''}`}
                    />
                    <div className="flex justify-between text-xs text-gray-500 mt-2 font-mono">
                        <span>{formatTime(localProgress)}</span>
                        <span>{formatTime(currentTrack?.duration || 0)}</span>
                    </div>
                 </div>

                 {/* Controls */}
                 <div className="flex items-center gap-8">
                     <VolumeControl 
                        volume={volume} 
                        onVolumeChange={setVolume}
                        muted={muted}
                        onToggleMute={() => setMuted(!muted)}
                     />

                     <button 
                        className={`p-4 rounded-full bg-white text-black transition-all shadow-lg shadow-cyan-500/20 ${isAllowedToControl ? 'hover:scale-105 active:scale-95' : 'opacity-50 cursor-not-allowed'}`}
                        onClick={roomState?.playbackState === PlaybackState.PLAYING ? handlePause : handlePlay}
                        disabled={!isAllowedToControl}
                     >
                         {roomState?.playbackState === PlaybackState.PLAYING ? (
                             <Pause size={32} fill="currentColor" />
                         ) : (
                             <Play size={32} fill="currentColor" className="ml-1"/>
                         )}
                     </button>

                     <button 
                        onClick={handleNext}
                        disabled={!isAllowedToControl}
                        className={`text-gray-400 hover:text-white transition-colors ${!isAllowedToControl ? 'opacity-30 cursor-not-allowed' : ''}`}
                     >
                         <SkipForward size={28} />
                     </button>
                 </div>
                 
                 {!isAllowedToControl && (
                     <div className="mt-6 text-sm text-gray-500 flex items-center gap-2">
                         <Lock size={12} />
                         <span>Ask admin for play permission</span>
                     </div>
                 )}
             </div>
        </main>

        {/* RIGHT: Queue */}
        <aside className={`
            border-l border-gray-800 flex-col
            ${mobileTab === 'queue' ? 'flex absolute inset-0 z-20 w-full bg-gray-900' : 'hidden'}
            lg:flex lg:static lg:w-80 lg:inset-auto lg:bg-gray-900/50 lg:z-auto
        `}>
            <div className="p-4 border-b border-gray-800 flex justify-between items-center">
                 <h2 className="text-xs font-bold text-gray-500 uppercase tracking-wider">Queue</h2>
                 <button 
                    onClick={() => setShowBroadcastModal(true)}
                    className="flex items-center gap-1 text-cyan-400 hover:text-cyan-300 transition-colors text-xs font-bold border border-cyan-900 bg-cyan-900/20 px-2 py-1 rounded-full"
                 >
                     <Radio size={14} /> Detect & Broadcast
                 </button>
            </div>
            <div className="flex-1 overflow-y-auto p-2">
                {roomState?.queue.map((track, idx) => (
                    <div 
                        key={track.id} 
                        onClick={() => handlePlayTrack(track.id)}
                        className={`flex items-center gap-3 p-3 rounded-lg mb-2 transition-colors 
                        ${track.id === roomState.currentTrackId ? 'bg-gray-800 border border-gray-700' : 'hover:bg-gray-800/50'}
                        ${isAllowedToControl ? 'cursor-pointer hover:bg-gray-700' : 'cursor-default'}`}
                    >
                        <div className="relative w-10 h-10 shrink-0">
                            <img src={track.coverUrl} className="w-full h-full rounded object-cover" alt="" />
                            {track.id === roomState.currentTrackId && roomState.playbackState === PlaybackState.PLAYING && (
                                <div className="absolute inset-0 bg-black/50 flex items-center justify-center rounded">
                                    <div className="w-3 h-3 bg-cyan-400 rounded-full animate-pulse"></div>
                                </div>
                            )}
                            {/* Hover Play Icon for Allowed Users */}
                            {isAllowedToControl && track.id !== roomState.currentTrackId && (
                                <div className="absolute inset-0 bg-black/50 flex items-center justify-center rounded opacity-0 hover:opacity-100 transition-opacity">
                                    <Play size={16} fill="white" className="text-white" />
                                </div>
                            )}
                        </div>
                        <div className="min-w-0 flex-1">
                            <div className={`text-sm font-medium truncate ${track.id === roomState.currentTrackId ? 'text-cyan-400' : 'text-gray-200'}`}>
                                {track.title}
                            </div>
                            <div className="text-xs text-gray-500 truncate">{track.artist}</div>
                        </div>
                        {track.type === 'shared-file' && (
                             <Tooltip text="Shared Broadcast">
                                 <Radio size={12} className="text-cyan-500" />
                             </Tooltip>
                        )}
                    </div>
                ))}
            </div>
        </aside>
      </div>

      {/* MOBILE NAV (Bottom) */}
      <div className="md:hidden border-t border-gray-800 bg-gray-900 p-4 flex justify-around shrink-0 z-30">
          <button onClick={() => setMobileTab('members')} className={`flex flex-col items-center gap-1 ${mobileTab === 'members' ? 'text-cyan-400' : 'text-gray-500'}`}>
              <Users size={24} />
              <span className="text-[10px]">Members</span>
          </button>
          <button onClick={() => setMobileTab('player')} className={`flex flex-col items-center gap-1 ${mobileTab === 'player' ? 'text-cyan-400' : 'text-gray-500'}`}>
              <Music2 size={24} />
              <span className="text-[10px]">Player</span>
          </button>
          <button onClick={() => setMobileTab('queue')} className={`flex flex-col items-center gap-1 ${mobileTab === 'queue' ? 'text-cyan-400' : 'text-gray-500'}`}>
              <ListMusic size={24} />
              <span className="text-[10px]">Queue</span>
          </button>
      </div>
    </div>
  );
}