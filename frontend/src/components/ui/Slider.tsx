import React, { memo } from 'react';
import { motion } from 'framer-motion';

export interface SliderOption<T> {
  value: T;
  text: string;
}

export interface SliderOptions<T> {
  left: SliderOption<T>;
  middle?: SliderOption<T>;
  right: SliderOption<T>;
}

interface SliderProps<T> {
  selected: T;
  options: SliderOptions<T>;
  setSelected?: (selected: T) => void;
}

const cubicEasingFn = [0.4, 0, 0.2, 1] as const;

export const Slider = memo(function Slider<T>({ selected, options, setSelected }: SliderProps<T>) {
  const hasMiddle = !!options.middle;
  const isLeftSelected = selected === options.left.value;
  const isMiddleSelected = hasMiddle && options.middle ? selected === options.middle.value : false;
  const isRightSelected = !isLeftSelected && !isMiddleSelected;

  return (
    <div className="flex items-center flex-wrap shrink-0 gap-1 bg-bolt-elements-background-depth-1 overflow-hidden rounded-full p-1">
      <SliderButton
        selected={isLeftSelected}
        onClick={() => setSelected?.(options.left.value)}
      >
        {options.left.text}
      </SliderButton>

      {options.middle && (
        <SliderButton
          selected={isMiddleSelected}
          onClick={() => setSelected?.(options.middle!.value)}
        >
          {options.middle.text}
        </SliderButton>
      )}

      <SliderButton
        selected={isRightSelected}
        onClick={() => setSelected?.(options.right.value)}
      >
        {options.right.text}
      </SliderButton>
    </div>
  );
}) as <T>(props: SliderProps<T>) => React.ReactElement;

interface SliderButtonProps {
  selected: boolean;
  children: string | React.ReactElement | Array<React.ReactElement | string>;
  onClick: () => void;
}

const SliderButton = memo(({ selected, children, onClick }: SliderButtonProps) => {
  return (
    <button
      onClick={onClick}
      className={`bg-transparent text-sm px-2.5 py-0.5 rounded-full relative ${
        selected
          ? 'text-bolt-elements-item-contentAccent'
          : 'text-bolt-elements-item-contentDefault hover:text-bolt-elements-item-contentActive'
      }`}
    >
      <span className="relative z-10">{children}</span>
      {selected && (
        <motion.span
          layoutId="pill-tab"
          transition={{ duration: 0.2, ease: cubicEasingFn }}
          className="absolute inset-0 z-0 bg-bolt-elements-item-backgroundAccent rounded-full"
        />
      )}
    </button>
  );
});

SliderButton.displayName = 'SliderButton';
