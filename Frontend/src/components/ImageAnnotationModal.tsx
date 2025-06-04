import React, { useEffect, useRef, useState } from 'react';

interface ImageAnnotationModalProps {
  isOpen: boolean;
  file: File | null;
  onSave: (file: File) => void;
  onCancel: () => void;
}

const ImageAnnotationModal: React.FC<ImageAnnotationModalProps> = ({
  isOpen,
  file,
  onSave,
  onCancel
}) => {
  const baseCanvasRef = useRef<HTMLCanvasElement>(null);
  const drawCanvasRef = useRef<HTMLCanvasElement>(null);
  const [color, setColor] = useState('#ff0000');
  const [lineWidth, setLineWidth] = useState(3);
  const [isDrawing, setIsDrawing] = useState(false);
  const lastPos = useRef<{ x: number; y: number } | null>(null);

  useEffect(() => {
    if (!isOpen || !file) return;
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => {
      const baseCanvas = baseCanvasRef.current;
      const drawCanvas = drawCanvasRef.current;
      if (!baseCanvas || !drawCanvas) return;
      baseCanvas.width = img.width;
      baseCanvas.height = img.height;
      drawCanvas.width = img.width;
      drawCanvas.height = img.height;
      const ctx = baseCanvas.getContext('2d');
      ctx?.drawImage(img, 0, 0);
    };
    img.src = url;
    return () => {
      URL.revokeObjectURL(url);
    };
  }, [isOpen, file]);

  const getPos = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const canvas = drawCanvasRef.current;
    if (!canvas) return { x: 0, y: 0 };
    const rect = canvas.getBoundingClientRect();
    return {
      x: e.clientX - rect.left,
      y: e.clientY - rect.top
    };
  };

  const handlePointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!drawCanvasRef.current) return;
    setIsDrawing(true);
    lastPos.current = getPos(e);
  };

  const handlePointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!isDrawing || !drawCanvasRef.current) return;
    const ctx = drawCanvasRef.current.getContext('2d');
    if (!ctx) return;
    ctx.strokeStyle = color;
    ctx.lineWidth = lineWidth;
    ctx.lineCap = 'round';
    const pos = getPos(e);
    const last = lastPos.current;
    if (last) {
      ctx.beginPath();
      ctx.moveTo(last.x, last.y);
      ctx.lineTo(pos.x, pos.y);
      ctx.stroke();
    }
    lastPos.current = pos;
  };

  const endDrawing = () => {
    setIsDrawing(false);
    lastPos.current = null;
  };

  const handleSave = () => {
    if (!file || !baseCanvasRef.current || !drawCanvasRef.current) return;
    const exportCanvas = document.createElement('canvas');
    exportCanvas.width = baseCanvasRef.current.width;
    exportCanvas.height = baseCanvasRef.current.height;
    const ctx = exportCanvas.getContext('2d');
    if (!ctx) return;
    ctx.drawImage(baseCanvasRef.current, 0, 0);
    ctx.drawImage(drawCanvasRef.current, 0, 0);
    exportCanvas.toBlob((blob) => {
      if (!blob) return;
      const annotatedFile = new File([blob], file.name, { type: 'image/png' });
      onSave(annotatedFile);
    }, 'image/png');
  };

  if (!isOpen || !file) return null;

  return (
    <div className="annotation-overlay">
      <div className="annotation-container">
        <div className="annotation-canvas-wrapper">
          <canvas ref={baseCanvasRef} className="annotation-base" />
          <canvas
            ref={drawCanvasRef}
            className="annotation-draw"
            onPointerDown={handlePointerDown}
            onPointerMove={handlePointerMove}
            onPointerUp={endDrawing}
            onPointerLeave={endDrawing}
          />
        </div>
        <div className="annotation-controls">
          <label>
            Color
            <input
              type="color"
              value={color}
              onChange={(e) => setColor(e.target.value)}
            />
          </label>
          <label>
            Width
            <input
              type="range"
              min={1}
              max={10}
              value={lineWidth}
              onChange={(e) => setLineWidth(Number(e.target.value))}
            />
          </label>
          <div className="annotation-action-buttons">
            <button className="modal-button cancel-button" onClick={onCancel}>
              Cancel
            </button>
            <button className="modal-button confirm-button" onClick={handleSave}>
              Save
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};

export default ImageAnnotationModal;
