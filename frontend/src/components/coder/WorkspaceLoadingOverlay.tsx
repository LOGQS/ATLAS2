import React from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import '../../styles/coder/WorkspaceLoadingOverlay.css';

interface WorkspaceLoadingOverlayProps {
  isVisible: boolean;
}

export const WorkspaceLoadingOverlay: React.FC<WorkspaceLoadingOverlayProps> = ({ isVisible }) => {
  return (
    <AnimatePresence>
      {isVisible && (
        <motion.div
          className="workspace-loading-overlay"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.8, ease: [0.16, 1, 0.3, 1] }}
        >
          <motion.div
            className="workspace-loading-card"
            initial={{ opacity: 0, scale: 0.95, y: 20 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.97, y: -10 }}
            transition={{ duration: 0.8, ease: [0.16, 1, 0.3, 1] }}
          >
            <div className="workspace-loading-content">
              {/* Animated spinner */}
              <div className="workspace-loading-spinner">
                <svg className="workspace-loading-spinner-svg" viewBox="0 0 50 50">
                  <circle
                    className="workspace-loading-spinner-circle"
                    cx="25"
                    cy="25"
                    r="20"
                    fill="none"
                    strokeWidth="4"
                  />
                </svg>
              </div>

              {/* Loading text */}
              <div className="workspace-loading-text">Loading workspace...</div>

              {/* Indeterminate progress bar */}
              <div className="workspace-loading-bar-container">
                <div className="workspace-loading-bar">
                  <div className="workspace-loading-bar-fill" />
                </div>
              </div>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
};
