import React, { useEffect, useState } from 'react';
import { useWebContext } from '../../contexts/WebContext';
import { Icons } from '../ui/Icons';
import logger from '../../utils/core/logger';

export const BrowserSettingsOverlay: React.FC = () => {
  const {
    profiles,
    loadProfiles,
    deleteProfile,
    launchProfileSetup,
    setShowBrowserSettings
  } = useWebContext();

  const [isLoading, setIsLoading] = useState(true);
  const [deletingProfile, setDeletingProfile] = useState<string | null>(null);

  useEffect(() => {
    const load = async () => {
      setIsLoading(true);
      await loadProfiles();
      setIsLoading(false);
    };

    load();
  }, [loadProfiles]);

  const handleDeleteProfile = async (profileName: string) => {
    if (!window.confirm(`Are you sure you want to delete the profile "${profileName}"?`)) {
      return;
    }

    setDeletingProfile(profileName);
    const success = await deleteProfile(profileName);
    setDeletingProfile(null);

    if (success) {
      logger.info('[BROWSER_SETTINGS] Profile deleted successfully:', profileName);
    }
  };

  const handleCreateNewProfile = async () => {
    logger.info('[BROWSER_SETTINGS] Creating new profile');
    await launchProfileSetup();
  };

  const handleClose = () => {
    setShowBrowserSettings(false);
  };

  return (
    <div className="browser-settings-overlay">
      <div className="browser-settings-overlay__backdrop" onClick={handleClose}></div>

      <div className="browser-settings-overlay__panel">
        {/* Header */}
        <div className="browser-settings-overlay__header">
          <div className="flex items-center gap-3">
            <Icons.Settings className="w-6 h-6 text-cyan-400" />
            <h2 className="text-xl font-bold text-white">Browser Profiles</h2>
          </div>
          <button
            onClick={handleClose}
            className="browser-settings-overlay__close-btn"
            aria-label="Close"
          >
            <Icons.X className="w-5 h-5" />
          </button>
        </div>

        {/* Content */}
        <div className="browser-settings-overlay__content">
          <p className="text-gray-400 text-sm mb-6">
            Manage your browser profiles for enhanced anti-bot detection. Each profile stores cookies, consent, and browsing data.
          </p>

          {/* Profiles List */}
          {isLoading ? (
            <div className="flex items-center justify-center py-12">
              <div className="w-8 h-8 border-2 border-cyan-400 border-t-transparent rounded-full animate-spin"></div>
            </div>
          ) : profiles.length === 0 ? (
            <div className="browser-settings-overlay__empty">
              <Icons.Database className="w-12 h-12 text-gray-600 mb-3" />
              <p className="text-gray-400 text-sm">No browser profiles found</p>
              <p className="text-gray-500 text-xs mt-1">Create your first profile to get started</p>
            </div>
          ) : (
            <div className="browser-settings-overlay__profiles">
              {profiles.map((profile) => (
                <div key={profile.name} className="browser-settings-overlay__profile">
                  <div className="flex items-start gap-3 flex-1">
                    <div className="browser-settings-overlay__profile-icon">
                      {profile.valid ? (
                        <Icons.CheckCircle className="w-5 h-5 text-green-400" />
                      ) : (
                        <Icons.Info className="w-5 h-5 text-yellow-400" />
                      )}
                    </div>

                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 mb-1">
                        <h3 className="text-white font-medium truncate">{profile.name}</h3>
                        {profile.is_default && (
                          <span className="browser-settings-overlay__badge">Default</span>
                        )}
                      </div>
                      <p className="text-gray-500 text-xs truncate">{profile.path}</p>
                      <div className="flex items-center gap-4 mt-2 text-xs text-gray-400">
                        <span>{profile.file_count} files</span>
                        <span className={profile.valid ? 'text-green-400' : 'text-yellow-400'}>
                          {profile.valid ? 'Valid' : 'Invalid'}
                        </span>
                      </div>
                    </div>
                  </div>

                  <div className="flex items-center gap-2">
                    {!profile.is_default && (
                      <button
                        onClick={() => handleDeleteProfile(profile.name)}
                        className="browser-settings-overlay__profile-btn browser-settings-overlay__profile-btn--danger"
                        disabled={deletingProfile === profile.name}
                        title="Delete profile"
                      >
                        {deletingProfile === profile.name ? (
                          <div className="w-4 h-4 border-2 border-current border-t-transparent rounded-full animate-spin"></div>
                        ) : (
                          <Icons.Delete className="w-4 h-4" />
                        )}
                      </button>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}

          {/* Actions */}
          <div className="browser-settings-overlay__actions">
            <button
              onClick={handleCreateNewProfile}
              className="browser-settings-overlay__btn browser-settings-overlay__btn--primary"
            >
              <Icons.Add className="w-4 h-4" />
              <span>Create New Profile</span>
            </button>

            <button
              onClick={async () => {
                setIsLoading(true);
                await loadProfiles();
                setIsLoading(false);
              }}
              className="browser-settings-overlay__btn browser-settings-overlay__btn--secondary"
              disabled={isLoading}
            >
              <Icons.RotateCw className={`w-4 h-4 ${isLoading ? 'animate-spin' : ''}`} />
              <span>Refresh</span>
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
