import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import '../../styles/visualization/TreeVisualization.css';
import { VersionNode } from '../versioning/VersioningHelpers';

const LAYOUT_CONFIG = {
  NODE_WIDTH: 120,
  NODE_HEIGHT: 60,
  LEVEL_HEIGHT: 100,
  SIBLING_SPACING: 150,
  BORDER_RADIUS: 12,
  INITIAL_Y: 50,
  LINE_WIDTH: 1.5,
  HOVER_LINE_WIDTH: 2,
  TEXT_MAX_LENGTH: 18
} as const;

interface LayoutNode {
  id: string;
  name: string;
  x: number;
  y: number;
  width: number;
  height: number;
  isActive: boolean;
  isVersion: boolean;
  children: LayoutNode[];
}

interface TreeVisualizationProps {
  root: VersionNode;
  currentId?: string;
  onNodeClick: (nodeId: string) => void;
}

const TreeVisualization: React.FC<TreeVisualizationProps> = ({
  root,
  currentId,
  onNodeClick
}) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const contextRef = useRef<CanvasRenderingContext2D | null>(null);
  const [hoveredNode, setHoveredNode] = useState<string | null>(null);
  const [dimensions, setDimensions] = useState({ width: 800, height: 600 });
  const animationFrameRef = useRef<number | null>(null);

  const calculateLayout = useCallback((node: VersionNode, x: number, y: number, level: number, parentX?: number): LayoutNode => {
    const layout: LayoutNode = {
      id: node.id,
      name: node.name,
      x,
      y,
      width: LAYOUT_CONFIG.NODE_WIDTH,
      height: LAYOUT_CONFIG.NODE_HEIGHT,
      isActive: node.id === currentId,
      isVersion: node.isversion,
      children: []
    };

    if (node.children && node.children.length > 0) {
      const totalWidth = node.children.length * LAYOUT_CONFIG.SIBLING_SPACING;
      const startX = x - totalWidth / 2 + LAYOUT_CONFIG.SIBLING_SPACING / 2;

      node.children.forEach((child, index) => {
        const childX = startX + index * LAYOUT_CONFIG.SIBLING_SPACING;
        const childY = y + LAYOUT_CONFIG.LEVEL_HEIGHT;
        layout.children.push(calculateLayout(child, childX, childY, level + 1, x));
      });
    }

    return layout;
  }, [currentId]);

  const layout = useMemo(() => {
    if (!root) return null;
    return calculateLayout(root, dimensions.width / 2, LAYOUT_CONFIG.INITIAL_Y, 0);
  }, [root, dimensions.width, calculateLayout]);

  const getContext = useCallback((): CanvasRenderingContext2D | null => {
    const canvas = canvasRef.current;
    if (!canvas) return null;

    if (!contextRef.current) {
      contextRef.current = canvas.getContext('2d');
    }
    return contextRef.current;
  }, []);

  const drawTree = useCallback(() => {
    if (!layout) return;

    const ctx = getContext();
    if (!ctx) return;

    const canvas = canvasRef.current;
    if (!canvas) return;

    ctx.clearRect(0, 0, dimensions.width, dimensions.height);

    ctx.font = '600 12px -apple-system, BlinkMacSystemFont, Segoe UI, Roboto, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';

    const drawConnections = (node: LayoutNode) => {
      if (node.children) {
        node.children.forEach((child: LayoutNode) => {
          ctx.beginPath();
          ctx.moveTo(node.x, node.y + node.height / 2);
          ctx.lineTo(child.x, child.y - child.height / 2);
          ctx.strokeStyle = 'rgba(255,255,255,0.25)';
          ctx.lineWidth = LAYOUT_CONFIG.LINE_WIDTH;
          ctx.stroke();
          drawConnections(child);
        });
      }
    };

    const drawNode = (node: LayoutNode) => {
      const x = node.x - node.width / 2;
      const y = node.y - node.height / 2;
      const w = node.width;
      const h = node.height;
      const r = LAYOUT_CONFIG.BORDER_RADIUS;

      ctx.beginPath();
      ctx.moveTo(x + r, y);
      ctx.lineTo(x + w - r, y);
      ctx.quadraticCurveTo(x + w, y, x + w, y + r);
      ctx.lineTo(x + w, y + h - r);
      ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
      ctx.lineTo(x + r, y + h);
      ctx.quadraticCurveTo(x, y + h, x, y + h - r);
      ctx.lineTo(x, y + r);
      ctx.quadraticCurveTo(x, y, x + r, y);
      ctx.closePath();

      if (node.isActive) {
        const grad = ctx.createLinearGradient(x, y, x + w, y + h);
        grad.addColorStop(0, 'rgba(255,146,79,0.25)');
        grad.addColorStop(1, 'rgba(74,144,226,0.18)');
        ctx.fillStyle = grad;
      } else if (node.isVersion) {
        ctx.fillStyle = 'rgba(33,150,243,0.25)';
      } else {
        ctx.fillStyle = 'rgba(156,39,176,0.25)';
      }
      ctx.fill();

      ctx.lineWidth = node.id === hoveredNode ? LAYOUT_CONFIG.HOVER_LINE_WIDTH : 1;
      ctx.strokeStyle = node.isActive
        ? 'rgba(255,146,79,0.45)'
        : node.isVersion
          ? 'rgba(33,150,243,0.45)'
          : 'rgba(156,39,176,0.45)';
      ctx.stroke();

      ctx.fillStyle = '#FFF';
      const displayText = node.name.length > LAYOUT_CONFIG.TEXT_MAX_LENGTH
        ? node.name.substring(0, LAYOUT_CONFIG.TEXT_MAX_LENGTH - 2) + '..'
        : node.name;
      ctx.fillText(displayText, node.x, node.y);

      if (node.children) {
        node.children.forEach((child: LayoutNode) => drawNode(child));
      }
    };

    drawConnections(layout);
    drawNode(layout);
  }, [layout, dimensions, hoveredNode, getContext]);

  const findNodeAtPosition = useCallback((x: number, y: number, node: LayoutNode | null): string | null => {
    if (!node) return null;

    if (
      x >= node.x - node.width / 2 &&
      x <= node.x + node.width / 2 &&
      y >= node.y - node.height / 2 &&
      y <= node.y + node.height / 2
    ) {
      return node.id;
    }

    if (node.children) {
      for (const child of node.children) {
        const found = findNodeAtPosition(x, y, child);
        if (found) return found;
      }
    }

    return null;
  }, []);

  const handleCanvasClick = useCallback((event: React.MouseEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    if (!canvas || !layout) return;

    const rect = canvas.getBoundingClientRect();
    const x = event.clientX - rect.left;
    const y = event.clientY - rect.top;

    const clickedNodeId = findNodeAtPosition(x, y, layout);
    if (clickedNodeId) {
      onNodeClick(clickedNodeId);
    }
  }, [layout, onNodeClick, findNodeAtPosition]);

  const handleCanvasMouseMove = useCallback((event: React.MouseEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    if (!canvas || !layout) return;

    const rect = canvas.getBoundingClientRect();
    const x = event.clientX - rect.left;
    const y = event.clientY - rect.top;

    const nodeId = findNodeAtPosition(x, y, layout);

    if (nodeId !== hoveredNode) {
      setHoveredNode(nodeId);
      canvas.style.cursor = nodeId ? 'pointer' : 'default';
    }
  }, [layout, hoveredNode, findNodeAtPosition]);


  useEffect(() => {
    if (animationFrameRef.current) {
      cancelAnimationFrame(animationFrameRef.current);
    }
    animationFrameRef.current = requestAnimationFrame(() => drawTree());

    return () => {
      if (animationFrameRef.current) {
        cancelAnimationFrame(animationFrameRef.current);
      }
    };
  }, [drawTree]);

  useEffect(() => {
    let resizeTimeout: NodeJS.Timeout;

    const handleResize = () => {
      clearTimeout(resizeTimeout);
      resizeTimeout = setTimeout(() => {
        if (canvasRef.current) {
          const parent = canvasRef.current.parentElement;
          if (parent) {
            setDimensions({
              width: parent.clientWidth,
              height: parent.clientHeight
            });
            contextRef.current = null;
          }
        }
      }, 100);
    };

    handleResize();
    window.addEventListener('resize', handleResize);

    return () => {
      clearTimeout(resizeTimeout);
      window.removeEventListener('resize', handleResize);
    };
  }, []);

  useEffect(() => {
    return () => {
      if (animationFrameRef.current) {
        cancelAnimationFrame(animationFrameRef.current);
      }
      contextRef.current = null;
    };
  }, []);

  if (!root) {
    return (
      <div className="tree-visualization">
        <div style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          height: '100%',
          color: 'rgba(255,255,255,0.5)'
        }}>
          No data to visualize
        </div>
      </div>
    );
  }

  return (
    <div className="tree-visualization">
      <canvas
        ref={canvasRef}
        width={dimensions.width}
        height={dimensions.height}
        onClick={handleCanvasClick}
        onMouseMove={handleCanvasMouseMove}
        onMouseLeave={() => setHoveredNode(null)}
      />
      <div className="tree-legend">
        <div className="legend-item">
          <span className="legend-color main"></span>
          <span>Main Chat</span>
        </div>
        <div className="legend-item">
          <span className="legend-color version"></span>
          <span>Version</span>
        </div>
        <div className="legend-item">
          <span className="legend-color active"></span>
          <span>Current</span>
        </div>
      </div>
    </div>
  );
};

export default TreeVisualization;
