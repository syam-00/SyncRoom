
export interface User {
  id: string;
  name: string;
  isHost: boolean; // Kept for backward compatibility, but adminId in RoomState is the source of truth
  avatar?: string;
}

export interface Track {
  id: string;
  title: string;
  artist: string;
  url: string; // For streams, this is the http URL. For shared files, this might be empty/placeholder.
  fileId?: string; // Reference to the file in StorageService (IndexedDB)
  duration: number; // in seconds
  coverUrl: string;
  type: 'stream' | 'shared-file';
}

export enum PlaybackState {
  PAUSED = 'PAUSED',
  PLAYING = 'PLAYING',
  BUFFERING = 'BUFFERING',
}

export interface RoomState {
  id: string;
  name: string;
  users: User[];
  queue: Track[];
  currentTrackId: string | null;
  playbackState: PlaybackState;
  startAtServerTime: number | null; // The server timestamp when the track started/resumed
  pausedAtPosition: number | null; // If paused, where we stopped (in seconds)
  adminId: string; // The ID of the room admin/host
  playAllowedUserIds: string[]; // List of IDs allowed to control playback
}

// Mock Socket Messages
export type SocketMessage = 
  | { type: 'room:update'; state: RoomState }
  | { type: 'user:joined'; user: User }
  | { type: 'user:left'; user: User }
  | { type: 'sync:ping'; clientSendTime: number }
  | { type: 'sync:pong'; clientSendTime: number; serverReceiveTime: number; serverReplyTime: number }
  | { type: 'play:scheduled'; trackId: string; playAtServerTime: number; startOffset: number }
  | { type: 'pause:sync'; pauseAtServerTime: number; position: number }
  | { type: 'seek:sync'; position: number; atServerTime: number }
  | { type: 'permission:denied'; reason: string };

export interface AudioStats {
  latency: number; // ms
  offset: number; // ms (Server Time - Client Time)
  drift: number; // ms
  jitter: number; // ms
}
