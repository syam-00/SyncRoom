import { RoomState, PlaybackState, User, Track, SocketMessage } from '../types';
import { database } from './database';

/**
 * MOCK SERVER LOGIC
 * This file simulates a backend server with Socket.IO.
 * It maintains the "Server Truth" and synchronizes it across browser tabs.
 */

// Global State (per browser tab instance)
let activeRoomId: string | null = null;
let mockState: RoomState | null = null;
let channel: BroadcastChannel | null = null;

const SAMPLE_TRACKS: Track[] = [
  {
    id: 't1',
    title: 'Neon Nights',
    artist: 'Synthwave Boy',
    url: 'https://www.soundhelix.com/examples/mp3/SoundHelix-Song-1.mp3',
    duration: 372,
    coverUrl: 'https://picsum.photos/id/10/300/300',
    type: 'stream'
  }
];

// Helpers
const getStorageKey = (roomId: string) => `syncroom_state_${roomId}`;
const getLockName = (roomId: string) => `syncroom_lock_${roomId}`;

const loadState = (roomId: string): RoomState => {
  try {
    const stored = localStorage.getItem(getStorageKey(roomId));
    if (stored) return JSON.parse(stored);
  } catch (e) {
    console.error("Failed to load state", e);
  }
  return {
    id: roomId,
    name: `Room ${roomId}`,
    users: [],
    queue: [...SAMPLE_TRACKS],
    currentTrackId: 't1',
    playbackState: PlaybackState.PAUSED,
    startAtServerTime: null,
    pausedAtPosition: 0,
    adminId: '',
    playAllowedUserIds: []
  };
};

const saveState = (state: RoomState) => {
  localStorage.setItem(getStorageKey(state.id), JSON.stringify(state));
};

/**
 * EXECUTE IN LOCK
 * Scoped to the active room
 */
const withLock = async (callback: () => void | Promise<void>) => {
  if (!activeRoomId) return;
  const lockName = getLockName(activeRoomId);
  
  if (navigator.locks) {
    await navigator.locks.request(lockName, async () => {
      await callback();
    });
  } else {
    await callback();
  }
};

type EventHandler = (data: any) => void;
const listeners: Record<string, EventHandler[]> = {};

function broadcastToLocal(event: string, data: any) {
  if (listeners[event]) listeners[event].forEach(cb => cb(data));
}

function broadcastGlobal(event: string, data: any) {
  setTimeout(() => broadcastToLocal(event, data), 0);
  if (channel) {
      setTimeout(() => channel?.postMessage({ type: event, payload: data }), 0);
  }
}

// Global Storage Listener
window.addEventListener('storage', (e) => {
  if (activeRoomId && e.key === getStorageKey(activeRoomId) && e.newValue) {
    try {
      const newState = JSON.parse(e.newValue);
      // Determine if we need to notify the UI
      if (!mockState || 
          newState.playbackState !== mockState.playbackState || 
          newState.currentTrackId !== mockState.currentTrackId ||
          newState.users.length !== mockState.users.length ||
          newState.playAllowedUserIds.length !== mockState.playAllowedUserIds.length) {
           mockState = newState;
           broadcastToLocal('room:update', newState);
      } else {
           mockState = newState;
      }
    } catch (err) {
      console.error("Error parsing storage update", err);
    }
  }
});

const randomDelay = () => Math.random() * 100 + 50;

export const MockSocket = {
  connect: (userName: string, roomId: string): Promise<User> => {
    return new Promise((resolve) => {
      activeRoomId = roomId;

      // Initialize BroadcastChannel for this room
      if (channel) channel.close();
      channel = new BroadcastChannel(`syncroom_channel_${roomId}`);
      channel.onmessage = (event) => {
          const { type, payload } = event.data;
          if (type === 'room:update') {
            mockState = payload;
          }
          broadcastToLocal(type, payload);
      };

      setTimeout(() => {
        withLock(async () => {
            mockState = loadState(roomId);

            const userId = Math.random().toString(36).substr(2, 9);
            const isFirstUser = mockState.users.length === 0;
            
            if (isFirstUser) {
                mockState.adminId = userId;
                mockState.playAllowedUserIds = [userId];
                await database.setPermission(roomId, userId, true);
            } else if (!mockState.adminId) {
                // Recover admin if missing
                mockState.adminId = userId;
                mockState.playAllowedUserIds = [userId];
                await database.setPermission(roomId, userId, true);
            } else {
                // Check DB for existing permissions (re-join scenario)
                const allowedIds = await database.getPermissions(roomId);
                const combined = new Set([...mockState.playAllowedUserIds, ...allowedIds]);
                mockState.playAllowedUserIds = Array.from(combined);
            }

            const newUser: User = {
                id: userId,
                name: userName,
                isHost: userId === mockState.adminId,
                avatar: `https://api.dicebear.com/7.x/avataaars/svg?seed=${userName}`
            };
            
            await database.upsertUser(newUser);
            
            mockState.users.push(newUser);
            saveState(mockState);
            
            broadcastGlobal('room:update', { ...mockState });
            broadcastGlobal('user:joined', { user: newUser });
            resolve(newUser);
        });
      }, randomDelay());
    });
  },

  disconnect: (userId: string) => {
      setTimeout(() => {
        withLock(() => {
            if (!activeRoomId) return;
            mockState = loadState(activeRoomId);
            const userLeaving = mockState.users.find(u => u.id === userId);
            
            mockState.users = mockState.users.filter(u => u.id !== userId);
            
            if (userId === mockState.adminId) {
                if (mockState.users.length > 0) {
                    const newAdmin = mockState.users[0];
                    mockState.adminId = newAdmin.id;
                    newAdmin.isHost = true;
                    if (!mockState.playAllowedUserIds.includes(newAdmin.id)) {
                        mockState.playAllowedUserIds.push(newAdmin.id);
                        database.setPermission(mockState.id, newAdmin.id, true);
                    }
                } else {
                    mockState.adminId = '';
                    mockState.playAllowedUserIds = [];
                }
            }
            mockState.playAllowedUserIds = mockState.playAllowedUserIds.filter(id => 
                mockState.users.some(u => u.id === id) || id === mockState.adminId
            );
            mockState.users.forEach(u => {
                u.isHost = u.id === mockState.adminId;
            });
            
            saveState(mockState);
            broadcastGlobal('room:update', { ...mockState });
            if (userLeaving) {
                broadcastGlobal('user:left', { user: userLeaving });
            }
        });
      }, 0);
  },

  on: (event: string, callback: EventHandler) => {
    if (!listeners[event]) listeners[event] = [];
    listeners[event].push(callback);
  },

  off: (event: string, callback: EventHandler) => {
    if (!listeners[event]) return;
    listeners[event] = listeners[event].filter(cb => cb !== callback);
  },

  emit: (event: string, payload: any) => {
    setTimeout(() => {
        withLock(() => {
            if (mockState) {
                handleServerEvent(event, payload);
            }
        });
    }, randomDelay());
  },

  getServerTime: () => Date.now()
};

function handleServerEvent(event: string, payload: any) {
  if (!activeRoomId) return;
  const serverNow = MockSocket.getServerTime();
  // Reload state to ensure we have latest before modifying
  mockState = loadState(activeRoomId);

  const { userId } = payload;
  
  const hasPermission = () => {
      return mockState && mockState.playAllowedUserIds.includes(userId);
  };
  
  const isAdmin = () => {
      return mockState && mockState.adminId === userId;
  };
  
  if (!mockState) return;

  switch (event) {
    case 'sync:ping':
      broadcastToLocal('sync:pong', {
        clientSendTime: payload.clientSendTime,
        serverReceiveTime: serverNow,
        serverReplyTime: serverNow, 
      });
      return;

    case 'cmd:grantPlay':
        if (isAdmin()) {
            const { targetUserId } = payload;
            if (!mockState.playAllowedUserIds.includes(targetUserId)) {
                mockState.playAllowedUserIds.push(targetUserId);
                database.setPermission(mockState.id, targetUserId, true);
                
                saveState(mockState);
                broadcastGlobal('room:update', { ...mockState });
            }
        }
        break;

    case 'cmd:revokePlay':
        if (isAdmin()) {
            const { targetUserId } = payload;
            if (targetUserId !== mockState.adminId) {
                mockState.playAllowedUserIds = mockState.playAllowedUserIds.filter(id => id !== targetUserId);
                database.setPermission(mockState.id, targetUserId, false);

                saveState(mockState);
                broadcastGlobal('room:update', { ...mockState });
            }
        }
        break;

    case 'cmd:play':
      if (hasPermission() && mockState.playbackState !== PlaybackState.PLAYING) {
        const leadTime = 500;
        const playAt = serverNow + leadTime;
        
        mockState.playbackState = PlaybackState.PLAYING;
        mockState.startAtServerTime = playAt - (mockState.pausedAtPosition || 0) * 1000;
        
        if (mockState.currentTrackId) {
            database.logPlay(mockState.id, mockState.currentTrackId, userId);
        }

        saveState(mockState);
        broadcastGlobal('room:update', { ...mockState });
        broadcastGlobal('play:scheduled', {
          trackId: mockState.currentTrackId,
          playAtServerTime: playAt,
          startOffset: mockState.pausedAtPosition || 0
        });
      }
      break;

    case 'cmd:playSpecificTrack':
        if (hasPermission()) {
            const { trackId } = payload;
            if (mockState.queue.some(t => t.id === trackId)) {
                const playAt = serverNow + 800;
                
                mockState.currentTrackId = trackId;
                mockState.playbackState = PlaybackState.PLAYING;
                mockState.pausedAtPosition = 0;
                mockState.startAtServerTime = playAt;

                database.logPlay(mockState.id, trackId, userId);
                
                saveState(mockState);
                broadcastGlobal('room:update', { ...mockState });
                broadcastGlobal('play:scheduled', {
                    trackId: trackId,
                    playAtServerTime: playAt,
                    startOffset: 0
                });
            }
        }
        break;

    case 'cmd:pause':
      if (hasPermission() && mockState.playbackState === PlaybackState.PLAYING) {
        const pauseAt = serverNow;
        const elapsed = mockState.startAtServerTime ? (pauseAt - mockState.startAtServerTime) / 1000 : 0;
        
        mockState.playbackState = PlaybackState.PAUSED;
        mockState.pausedAtPosition = elapsed;
        mockState.startAtServerTime = null;
        
        saveState(mockState);
        broadcastGlobal('room:update', { ...mockState });
        broadcastGlobal('pause:sync', {
          pauseAtServerTime: pauseAt,
          position: elapsed
        });
      }
      break;
    
    case 'cmd:seek':
      if (hasPermission()) {
        const { position } = payload;
        const seekAt = serverNow + 300;
        
        mockState.pausedAtPosition = position;
        if (mockState.playbackState === PlaybackState.PLAYING) {
            mockState.startAtServerTime = seekAt - (position * 1000);
        }
        
        saveState(mockState);
        broadcastGlobal('room:update', { ...mockState });
        broadcastGlobal('seek:sync', { position, atServerTime: seekAt });
      }
      break;
      
    case 'cmd:addTrack':
      const newTrack: Track = payload;
      mockState.queue.push(newTrack);

      if (newTrack.type === 'shared-file') {
          database.addSong({
              id: newTrack.id,
              title: newTrack.title,
              artist: newTrack.artist,
              url: newTrack.url,
              duration: newTrack.duration,
              coverUrl: newTrack.coverUrl,
              uploadedBy: userId,
              type: 'shared-file',
              fileId: newTrack.fileId
          });
      }

      saveState(mockState);
      broadcastGlobal('room:update', { ...mockState });
      break;
      
    case 'cmd:next':
        if (hasPermission()) {
            const currentIndex = mockState.queue.findIndex(t => t.id === mockState.currentTrackId);
            const nextTrack = mockState.queue[currentIndex + 1];
            if(nextTrack) {
                mockState.currentTrackId = nextTrack.id;
                mockState.playbackState = PlaybackState.PAUSED;
                mockState.pausedAtPosition = 0;
                mockState.startAtServerTime = null;
                saveState(mockState);
                broadcastGlobal('room:update', { ...mockState });
            }
        }
        break;
  }
}
