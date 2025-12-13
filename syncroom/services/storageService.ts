/**
 * STORAGE SERVICE (IndexedDB Wrapper)
 * Simulates a cloud storage bucket (e.g., S3) accessible by all clients (tabs).
 * Used to store large audio blobs that localStorage cannot handle.
 */

const DB_NAME = 'SyncRoom_Storage';
const STORE_NAME = 'audio_files';
const DB_VERSION = 1;

export const storageService = {
  async init() {
    return new Promise<void>((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);

      request.onupgradeneeded = (event) => {
        const db = (event.target as IDBOpenDBRequest).result;
        if (!db.objectStoreNames.contains(STORE_NAME)) {
          db.createObjectStore(STORE_NAME);
        }
      };

      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
    });
  },

  async uploadFile(file: Blob): Promise<string> {
    await this.init();
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);
      request.onsuccess = () => {
        const db = request.result;
        const tx = db.transaction(STORE_NAME, 'readwrite');
        const store = tx.objectStore(STORE_NAME);
        
        const fileId = `file_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
        const putRequest = store.put(file, fileId);

        putRequest.onsuccess = () => resolve(fileId);
        putRequest.onerror = () => reject(putRequest.error);
      };
      request.onerror = () => reject(request.error);
    });
  },

  async getFile(fileId: string): Promise<Blob | null> {
    await this.init();
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);
      request.onsuccess = () => {
        const db = request.result;
        const tx = db.transaction(STORE_NAME, 'readonly');
        const store = tx.objectStore(STORE_NAME);
        const getRequest = store.get(fileId);

        getRequest.onsuccess = () => resolve(getRequest.result || null);
        getRequest.onerror = () => reject(getRequest.error);
      };
      request.onerror = () => reject(request.error);
    });
  }
};
