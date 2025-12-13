import { Track, User } from '../types';

/**
 * DATABASE CONFIGURATION
 * Simulating environment variables for DB connection
 */
const DB_CONFIG = {
  NAME: 'SyncRoom_DB', // process.env.DB_NAME
  VERSION: 1,          // process.env.DB_VERSION
};

/**
 * SCHEMA INTERFACES
 */
export interface UserRecord {
  id: string;
  name: string;
  role: 'admin' | 'user';
  createdAt: number;
}

export interface SongRecord {
  id: string;
  title: string;
  artist: string; // "uploadedBy" usually implies user ID, but simplified to artist/name for now or kept as separate field
  url: string;
  duration: number;
  uploadedBy: string;
  coverUrl: string;
  createdAt: number;
  type: 'stream' | 'shared-file';
  fileId?: string;
}

export interface RoomRecord {
  id: string;
  name: string;
  adminId: string;
  createdAt: number;
}

export interface PermissionRecord {
  id: string; // compound key simulation or unique ID
  roomId: string;
  userId: string;
  canPlay: boolean;
}

export interface PlayHistoryRecord {
  id?: number; // Auto-increment
  roomId: string;
  songId: string;
  playedBy: string;
  playedAt: number;
}

// Initial Seed Data (Migration)
const INITIAL_SONGS: SongRecord[] = [
  {
    id: 'seed_1',
    title: "Cinematic Fairy Tale",
    artist: "Music H",
    url: "https://www.soundhelix.com/examples/mp3/SoundHelix-Song-1.mp3",
    duration: 372,
    coverUrl: "https://picsum.photos/seed/fairy/300/300",
    uploadedBy: 'system',
    createdAt: Date.now(),
    type: 'stream'
  },
  {
    id: 'seed_2',
    title: "Tech House Vibes",
    artist: "Electro C",
    url: "https://www.soundhelix.com/examples/mp3/SoundHelix-Song-2.mp3",
    duration: 425,
    coverUrl: "https://picsum.photos/seed/tech/300/300",
    uploadedBy: 'system',
    createdAt: Date.now(),
    type: 'stream'
  },
  {
    id: 'seed_3',
    title: "Deep Focus",
    artist: "Study Beats",
    url: "https://www.soundhelix.com/examples/mp3/SoundHelix-Song-3.mp3",
    duration: 320,
    coverUrl: "https://picsum.photos/seed/focus/300/300",
    uploadedBy: 'system',
    createdAt: Date.now(),
    type: 'stream'
  }
];

class DatabaseService {
  private db: IDBDatabase | null = null;

  async connect(): Promise<IDBDatabase> {
    if (this.db) return this.db;

    return new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_CONFIG.NAME, DB_CONFIG.VERSION);

      // MIGRATIONS & SCHEMA SETUP
      request.onupgradeneeded = (event) => {
        const db = (event.target as IDBOpenDBRequest).result;

        // 1. Users Table
        if (!db.objectStoreNames.contains('users')) {
          db.createObjectStore('users', { keyPath: 'id' });
        }

        // 2. Songs Table
        if (!db.objectStoreNames.contains('songs')) {
          const songStore = db.createObjectStore('songs', { keyPath: 'id' });
          songStore.createIndex('title', 'title', { unique: false });
          // Seed Data
          INITIAL_SONGS.forEach(song => songStore.add(song));
        }

        // 3. Rooms Table
        if (!db.objectStoreNames.contains('rooms')) {
          db.createObjectStore('rooms', { keyPath: 'id' });
        }

        // 4. Room Permissions Table
        if (!db.objectStoreNames.contains('room_permissions')) {
          const permStore = db.createObjectStore('room_permissions', { keyPath: 'id' });
          permStore.createIndex('room_user', ['roomId', 'userId'], { unique: true });
        }

        // 5. Play History Table
        if (!db.objectStoreNames.contains('play_history')) {
          const historyStore = db.createObjectStore('play_history', { keyPath: 'id', autoIncrement: true });
          historyStore.createIndex('roomId', 'roomId', { unique: false });
        }
      };

      request.onsuccess = () => {
        this.db = request.result;
        resolve(this.db);
      };

      request.onerror = () => reject(request.error);
    });
  }

  // --- API: USER ---

  async upsertUser(user: User): Promise<void> {
    const db = await this.connect();
    return new Promise((resolve, reject) => {
      const tx = db.transaction('users', 'readwrite');
      const store = tx.objectStore('users');
      
      const record: UserRecord = {
        id: user.id,
        name: user.name,
        role: user.isHost ? 'admin' : 'user', // Basic mapping
        createdAt: Date.now()
      };

      store.put(record);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  // --- API: SONGS ---

  async addSong(song: Omit<SongRecord, 'createdAt'>): Promise<void> {
    const db = await this.connect();
    return new Promise((resolve, reject) => {
      const tx = db.transaction('songs', 'readwrite');
      const store = tx.objectStore('songs');
      store.add({ ...song, createdAt: Date.now() });
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  async getAllSongs(): Promise<SongRecord[]> {
    const db = await this.connect();
    return new Promise((resolve, reject) => {
      const tx = db.transaction('songs', 'readonly');
      const store = tx.objectStore('songs');
      const request = store.getAll();
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  async searchSongs(query: string): Promise<SongRecord[]> {
    // Simple client-side filtering since IDB full-text search is complex
    const allSongs = await this.getAllSongs();
    const lowerQ = query.toLowerCase();
    return allSongs.filter(s => 
      s.title.toLowerCase().includes(lowerQ) || 
      s.artist.toLowerCase().includes(lowerQ)
    );
  }

  // --- API: PERMISSIONS ---

  async setPermission(roomId: string, userId: string, canPlay: boolean): Promise<void> {
    const db = await this.connect();
    return new Promise((resolve, reject) => {
      const tx = db.transaction('room_permissions', 'readwrite');
      const store = tx.objectStore('room_permissions');
      const id = `${roomId}_${userId}`;
      
      if (canPlay) {
        store.put({ id, roomId, userId, canPlay: true });
      } else {
        store.delete(id);
      }
      
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  async getPermissions(roomId: string): Promise<string[]> {
    const db = await this.connect();
    return new Promise((resolve, reject) => {
      const tx = db.transaction('room_permissions', 'readonly');
      const store = tx.objectStore('room_permissions');
      // Scan all (inefficient for large DBs but fine for this demo)
      // A cursor or index range on roomId would be better
      const request = store.getAll();
      
      request.onsuccess = () => {
        const perms = request.result as PermissionRecord[];
        const userIds = perms
          .filter(p => p.roomId === roomId && p.canPlay)
          .map(p => p.userId);
        resolve(userIds);
      };
      request.onerror = () => reject(request.error);
    });
  }

  // --- API: HISTORY ---

  async logPlay(roomId: string, songId: string, userId: string): Promise<void> {
    const db = await this.connect();
    return new Promise((resolve, reject) => {
      const tx = db.transaction('play_history', 'readwrite');
      const store = tx.objectStore('play_history');
      store.add({
        roomId,
        songId,
        playedBy: userId,
        playedAt: Date.now()
      });
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }
}

export const database = new DatabaseService();
