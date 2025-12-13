import React from 'react';

interface TooltipProps {
  text: string;
  children: React.ReactNode;
}

export const Tooltip: React.FC<TooltipProps> = ({ text, children }) => {
  return (
    <div className="group relative flex items-center">
      {children}
      <div className="absolute bottom-full mb-2 hidden flex-col items-center group-hover:flex left-1/2 -translate-x-1/2 whitespace-nowrap z-50">
        <span className="relative z-10 p-2 text-xs leading-none text-white whitespace-no-wrap bg-black shadow-lg rounded-md">
          {text}
        </span>
        <div className="w-3 h-3 -mt-2 rotate-45 bg-black"></div>
      </div>
    </div>
  );
};