import React from 'react';
import { useWebContext } from '../../contexts/WebContext';
import { Icons } from '../ui/Icons';

export const ControllerView: React.FC = () => {
  const { currentUrl, pageContent, pageTitle } = useWebContext();

  return (
    <main className="web-controller-view">
      <div className="web-controller-view__browser">
        {/* Browser Controls */}
        <div className="web-browser__controls">
          <div className="flex items-center gap-1.5 text-gray-400">
            <button className="web-browser__btn">
              <Icons.ChevronLeft className="w-4 h-4" />
            </button>
            <button className="web-browser__btn">
              <Icons.ChevronRight className="w-4 h-4" />
            </button>
            <button className="web-browser__btn">
              <Icons.RotateCw className="w-4 h-4" />
            </button>
          </div>

          <div className="web-browser__url-bar">
            <span className="text-sm text-gray-300">{currentUrl || 'Enter URL or search query...'}</span>
          </div>
        </div>

        {/* Browser Viewport */}
        <div className="web-browser__viewport">
          {pageContent ? (
            <div className="web-browser__content">
              <div className="bg-white text-black p-8">
                {pageTitle && (
                  <h1 className="text-4xl font-bold mb-4 text-black">{pageTitle}</h1>
                )}
                <div className="prose max-w-none">
                  <p className="text-gray-600 mb-6">Published on January 15, 2024</p>
                  <div className="space-y-4 text-gray-900">
                    {pageContent.split('\n\n').map((paragraph, index) => (
                      <p key={index} className="leading-relaxed">{paragraph}</p>
                    ))}
                  </div>
                </div>
              </div>
            </div>
          ) : (
            <div className="flex flex-col items-center justify-center h-full text-gray-400">
              <Icons.Globe className="w-16 h-16 mb-4 opacity-50" />
              <p className="text-sm">Navigate to a URL to start browsing</p>
            </div>
          )}
        </div>

        {/* Browser Actions */}
        <div className="web-browser__actions">
          <button className="web-browser__action-btn">
            <Icons.FileText className="w-4 h-4" />
            <span>Summarize Page</span>
          </button>
          <button className="web-browser__action-btn">
            <Icons.Database className="w-4 h-4" />
            <span>Extract Data</span>
          </button>
          <button className="web-browser__action-btn">
            <Icons.ExternalLink className="w-4 h-4" />
            <span>Go to Source</span>
          </button>
        </div>
      </div>
    </main>
  );
};
