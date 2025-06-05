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
  const [zoomLevel, setZoomLevel] = useState(100);
  const [panOffset, setPanOffset] = useState({ x: 0, y: 0 });
  const [isPanning, setIsPanning] = useState(false);
  const lastPos = useRef<{ x: number; y: number } | null>(null);
  const lastPanPos = useRef<{ x: number; y: number } | null>(null);
  
  // FIXED CANVAS SIZE
  const CANVAS_WIDTH = 1200;
  const CANVAS_HEIGHT = 700;

  useEffect(() => {
    if (!isOpen || !file) return;
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => {
      const baseCanvas = baseCanvasRef.current;
      const drawCanvas = drawCanvasRef.current;
      if (!baseCanvas || !drawCanvas) return;
      
      // Use fixed canvas dimensions
      baseCanvas.width = CANVAS_WIDTH;
      baseCanvas.height = CANVAS_HEIGHT;
      drawCanvas.width = CANVAS_WIDTH;
      drawCanvas.height = CANVAS_HEIGHT;
      
      const ctx = baseCanvas.getContext('2d');
      if (ctx) {
        // Clear the canvas
        ctx.clearRect(0, 0, CANVAS_WIDTH, CANVAS_HEIGHT);
        
        // Draw the image to fill the entire canvas (stretch to cover)
        ctx.drawImage(img, 0, 0, CANVAS_WIDTH, CANVAS_HEIGHT);
      }
    };
    img.src = url;
    return () => {
      URL.revokeObjectURL(url);
    };
  }, [isOpen, file]);

  const resetZoom = () => {
    setZoomLevel(100);
    setPanOffset({ x: 0, y: 0 });
  };

  const clearDrawings = () => {
    const drawCanvas = drawCanvasRef.current;
    if (drawCanvas) {
      const ctx = drawCanvas.getContext('2d');
      if (ctx) {
        ctx.clearRect(0, 0, CANVAS_WIDTH, CANVAS_HEIGHT);
      }
    }
  };

  const getPos = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const canvas = drawCanvasRef.current;
    if (!canvas) return { x: 0, y: 0 };
    const rect = canvas.getBoundingClientRect();
    
    // Simple approach: just map cursor to canvas coordinates directly
    // The canvas element itself is being transformed by CSS, so we just need basic mapping
    const x = ((e.clientX - rect.left) / rect.width) * CANVAS_WIDTH;
    const y = ((e.clientY - rect.top) / rect.height) * CANVAS_HEIGHT;
    
    return { x, y };
  };

  const handlePointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!drawCanvasRef.current) return;
    
    // Middle mouse button for panning
    if (e.button === 1) {
      setIsPanning(true);
      lastPanPos.current = { x: e.clientX, y: e.clientY };
      e.preventDefault();
      return;
    }
    
    // Left mouse button for drawing
    if (e.button === 0) {
      setIsDrawing(true);
      lastPos.current = getPos(e);
    }
  };

  const handlePointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    // Handle panning
    if (isPanning && lastPanPos.current) {
      const deltaX = e.clientX - lastPanPos.current.x;
      const deltaY = e.clientY - lastPanPos.current.y;
      setPanOffset(prev => ({
        x: prev.x + deltaX,
        y: prev.y + deltaY
      }));
      lastPanPos.current = { x: e.clientX, y: e.clientY };
      return;
    }
    
    // Handle drawing
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
    setIsPanning(false);
    lastPos.current = null;
    lastPanPos.current = null;
  };

  const handleWheel = (e: React.WheelEvent<HTMLCanvasElement>) => {
    // Only zoom when Alt key is held
    if (e.altKey) {
      e.preventDefault();
      const delta = -e.deltaY;
      const zoomStep = 25;
      
      if (delta > 0) {
        // Zoom in
        setZoomLevel(prev => Math.min(prev + zoomStep, 500));
      } else {
        // Zoom out
        setZoomLevel(prev => Math.max(prev - zoomStep, 25));
      }
    }
  };

  const handleSave = () => {
    if (!file || !baseCanvasRef.current || !drawCanvasRef.current) return;
    
    // Create new image to get original dimensions
    const originalImg = new Image();
    const url = URL.createObjectURL(file);
    
    originalImg.onload = () => {
      // Create canvas at original image size
      const exportCanvas = document.createElement('canvas');
      exportCanvas.width = originalImg.width;
      exportCanvas.height = originalImg.height;
      const ctx = exportCanvas.getContext('2d');
      if (!ctx) return;
      
      // Draw original image at full size
      ctx.drawImage(originalImg, 0, 0);
      
      // Scale and draw annotations
      const scaleX = originalImg.width / CANVAS_WIDTH;
      const scaleY = originalImg.height / CANVAS_HEIGHT;
      ctx.save();
      ctx.scale(scaleX, scaleY);
      ctx.drawImage(drawCanvasRef.current!, 0, 0);
      ctx.restore();
      
      // Export as blob
      exportCanvas.toBlob((blob) => {
        if (!blob) return;
        const annotatedFile = new File([blob], file.name, { type: 'image/png' });
        onSave(annotatedFile);
        URL.revokeObjectURL(url);
      }, 'image/png');
    };
    
    originalImg.src = url;
  };

  if (!isOpen || !file) return null;

  return (
    <div className="annotation-overlay">
      <div className="annotation-container">
        <div className="annotation-canvas-area">
          <div className="annotation-canvas-wrapper">
            <div 
              className="zoom-wrapper"
              style={{
                transform: `scale(${zoomLevel / 100}) translate(${panOffset.x}px, ${panOffset.y}px)`,
                transformOrigin: 'center center',
                transition: 'transform 0.2s ease'
              }}
            >
              <canvas 
                ref={baseCanvasRef} 
                className="annotation-base"
                width={CANVAS_WIDTH}
                height={CANVAS_HEIGHT}
              />
            </div>
            <canvas
              ref={drawCanvasRef}
              className="annotation-draw"
              width={CANVAS_WIDTH}
              height={CANVAS_HEIGHT}
              onPointerDown={handlePointerDown}
              onPointerMove={handlePointerMove}
              onPointerUp={endDrawing}
              onPointerLeave={endDrawing}
              onWheel={handleWheel}
              style={{
                position: 'absolute',
                top: 0,
                left: 0,
                width: '100%',
                height: '100%',
                pointerEvents: 'auto'
              }}
            />
          </div>
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
          <label>
            <span 
              onDoubleClick={resetZoom} 
              style={{ cursor: 'pointer', userSelect: 'none' }}
              title="Double-click to reset zoom and position"
            >
              Zoom: {zoomLevel}%
            </span>
            <input
              type="range"
              min={25}
              max={500}
              step={25}
              value={zoomLevel}
              onChange={(e) => setZoomLevel(Number(e.target.value))}
            />
          </label>
          <div className="annotation-action-buttons">
            <button className="modal-button cancel-button" onClick={onCancel}>
              Cancel
            </button>
            <button className="modal-button clear-button" onClick={clearDrawings}>
              Clear Drawings
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
