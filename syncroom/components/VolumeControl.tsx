import React from 'react';
import { Volume2, VolumeX } from 'lucide-react';

interface VolumeControlProps {
  volume: number;
  onVolumeChange: (val: number) => void;
  muted: boolean;
  onToggleMute: () => void;
}

export const VolumeControl: React.FC<VolumeControlProps> = ({ volume, onVolumeChange, muted, onToggleMute }) => {
  return (
    <div className="flex items-center gap-2 group">
      <button onClick={onToggleMute} className="text-gray-400 hover:text-white">
        {muted || volume === 0 ? <VolumeX size={20} /> : <Volume2 size={20} />}
      </button>
      <div className="w-0 overflow-hidden group-hover:w-24 transition-all duration-300 ease-in-out">
        <input
          type="range"
          min="0"
          max="1"
          step="0.05"
          value={muted ? 0 : volume}
          onChange={(e) => onVolumeChange(parseFloat(e.target.value))}
          className="w-full h-1 bg-gray-600 rounded-lg appearance-none cursor-pointer accent-cyan-500"
        />
      </div>
    </div>
  );
};