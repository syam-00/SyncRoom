import { AudioStats } from '../types';

interface SyncSample {
  rtt: number;
  offset: number;
  receivedAt: number;
}

export class SyncManager {
  private samples: SyncSample[] = [];
  private readonly WINDOW_SIZE = 20; // Sliding window size
  private currentOffset = 0; // (Server Time - Client Time)
  private currentLatency = 0;
  private drift = 0; // Clock drift (ms/sec)
  private jitter = 0; // Network jitter (ms)

  constructor() {}

  /**
   * Processes a Pong message with advanced filtering.
   * Algorithm: 
   * 1. Min-Filter: Uses the sample with minimum RTT as the best estimator for clock offset.
   * 2. Exponential Smoothing: Slews the offset to avoid discontinuous jumps in time.
   * 3. Jitter Calculation: Implements RFC 3550 jitter measurement.
   */
  processPong(clientSendTime: number, serverReceiveTime: number, serverReplyTime: number): AudioStats {
    const clientReceiveTime = Date.now();
    
    // RTT = (t4 - t1) - (t3 - t2)
    const networkDelay = (clientReceiveTime - clientSendTime) - (serverReplyTime - serverReceiveTime);
    const rtt = Math.max(0, networkDelay);

    // Raw Offset = ((t2 - t1) + (t3 - t4)) / 2
    const rawOffset = ((serverReceiveTime - clientSendTime) + (serverReplyTime - clientReceiveTime)) / 2;

    // --- Jitter Calculation (RFC 3550) ---
    // J(i) = J(i-1) + (|D(i-1,i)| - J(i-1))/16
    // Using RTT variation as a proxy for transit delay variation
    if (this.samples.length > 0) {
        const prevRtt = this.samples[this.samples.length - 1].rtt;
        const diff = Math.abs(rtt - prevRtt);
        this.jitter += (diff - this.jitter) / 16;
    }

    const sample: SyncSample = { 
        rtt, 
        offset: rawOffset, 
        receivedAt: clientReceiveTime 
    };

    // Update History
    this.samples.push(sample);
    if (this.samples.length > this.WINDOW_SIZE) {
      this.samples.shift();
    }

    // --- Min-Filter Selection ---
    // The sample with the lowest RTT implies the least queuing delay, 
    // effectively providing the most accurate "physical path" offset.
    const bestSample = this.samples.reduce((min, s) => (s.rtt < min.rtt ? s : min), this.samples[0]);
    const targetOffset = bestSample.offset;

    // --- Drift Calculation ---
    // Calculates skew between client and server clocks over time
    if (this.samples.length >= 2) {
        const oldest = this.samples[0];
        const newest = this.samples[this.samples.length - 1];
        const timeSpanSec = (newest.receivedAt - oldest.receivedAt) / 1000;
        
        if (timeSpanSec > 1) {
            this.drift = (newest.offset - oldest.offset) / timeSpanSec;
        }
    }

    // --- State Update with Smoothing ---
    // If the difference is massive (>500ms), snap immediately (re-sync).
    // Otherwise, slew smoothly (15% approach rate) to prevent audio glitches.
    if (this.currentOffset === 0 || Math.abs(targetOffset - this.currentOffset) > 500) {
        this.currentOffset = targetOffset;
    } else {
        this.currentOffset += (targetOffset - this.currentOffset) * 0.15;
    }
    
    this.currentLatency = bestSample.rtt / 2;

    return {
      latency: parseFloat(this.currentLatency.toFixed(2)),
      offset: parseFloat(this.currentOffset.toFixed(2)),
      drift: parseFloat(this.drift.toFixed(3)),
      jitter: parseFloat(this.jitter.toFixed(2))
    };
  }

  getEstimatedServerTime(): number {
    return Date.now() + this.currentOffset;
  }

  getLocalTimeFromServerTime(serverTime: number): number {
    return serverTime - this.currentOffset;
  }
  
  getOffset() {
      return this.currentOffset;
  }
}

export const syncManager = new SyncManager();
