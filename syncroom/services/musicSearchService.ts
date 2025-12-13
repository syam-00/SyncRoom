import { Track } from '../types';
import { database, SongRecord } from './database';

// Helper to map DB records to Track
const mapDbToTrack = (r: SongRecord): Track => ({
  id: r.id,
  title: r.title,
  artist: r.artist,
  url: r.url,
  duration: r.duration,
  coverUrl: r.coverUrl,
  type: r.type,
  fileId: r.fileId
});

export const musicSearchService = {
  
  /**
   * Search for songs from Local DB and Online API (iTunes)
   */
  async searchSongs(query: string): Promise<Track[]> {
    if (!query.trim()) return [];

    // 1. Local Search (Database)
    const localPromise = database.searchSongs(query)
      .then(results => results.map(mapDbToTrack))
      .catch(err => {
          console.error("Local search failed", err);
          return [];
      });

    // 2. Online Search (iTunes API)
    // Fetches 20 results, including 30s preview URLs
    const onlinePromise = fetch(`https://itunes.apple.com/search?term=${encodeURIComponent(query)}&media=music&entity=song&limit=20`)
        .then(res => {
            if (!res.ok) throw new Error(`iTunes API error: ${res.status}`);
            return res.json();
        })
        .then(data => {
            if (!data.results) return [];
            return data.results.map((item: any) => ({
                id: `itunes_${item.trackId}`,
                title: item.trackName,
                artist: item.artistName,
                url: item.previewUrl, // 30s audio preview
                duration: item.trackTimeMillis ? item.trackTimeMillis / 1000 : 30,
                coverUrl: item.artworkUrl100?.replace('100x100', '600x600') || 'https://picsum.photos/300/300',
                type: 'stream'
            })) as Track[];
        })
        .catch(err => {
            console.warn("iTunes API search failed (likely CORS or network)", err);
            return [] as Track[];
        });

    // Run searches in parallel
    const [localResults, onlineResults] = await Promise.all([localPromise, onlinePromise]);

    // Combine results (Local matches first)
    return [...localResults, ...onlineResults];
  },

  /**
   * Get all songs stored in the local library
   */
  async getAllSongs(): Promise<Track[]> {
      const dbSongs = await database.getAllSongs();
      return dbSongs.map(mapDbToTrack);
  }
};
