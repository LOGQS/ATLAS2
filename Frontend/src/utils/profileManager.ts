export interface Profile {
  id: string;
  name: string;
  vectorize: boolean;
  files?: string[];
}

export type ProfileListener = (profiles: Profile[], active: string | null) => void;

class ProfileManager {
  private static instance: ProfileManager;
  private profiles: Profile[] = [];
  private listeners: ProfileListener[] = [];
  private activeProfile: string | null = null;

  static getInstance(): ProfileManager {
    if (!ProfileManager.instance) {
      ProfileManager.instance = new ProfileManager();
    }
    return ProfileManager.instance;
  }

  private constructor() {
    const stored = localStorage.getItem('atlas_active_profile');
    if (stored) this.activeProfile = stored;
  }

  private emit() {
    this.listeners.forEach((cb) => cb(this.profiles, this.activeProfile));
  }

  public subscribe(cb: ProfileListener) {
    this.listeners.push(cb);
    cb(this.profiles, this.activeProfile);
    return () => {
      this.listeners = this.listeners.filter((l) => l !== cb);
    };
  }

  public getProfiles(): Profile[] {
    return this.profiles;
  }

  public getActiveProfile(): string | null {
    return this.activeProfile;
  }

  public async refresh(): Promise<void> {
    try {
      const res = await fetch('/api/profiles');
      if (res.ok) {
        const data = await res.json();
        this.profiles = data.profiles || [];
        
        // Load files for each profile (we'll always load files to show if KB should be enabled)
        for (const profile of this.profiles) {
          profile.files = await this.getFiles(profile.id);
        }
        
        this.emit();
      }
    } catch (err) {
      console.error('Failed to load profiles', err);
    }
  }

  public async create(name: string): Promise<void> {
    const res = await fetch('/api/profiles', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name })
    });
    if (res.ok) {
      await this.refresh();
    }
  }

  public async update(id: string, updates: Partial<Profile>): Promise<void> {
    await fetch(`/api/profiles/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(updates)
    });
    await this.refresh();
  }

  public async remove(id: string): Promise<void> {
    await fetch(`/api/profiles/${id}`, { method: 'DELETE' });
    if (this.activeProfile === id) {
      this.setActiveProfile(null);
    }
    await this.refresh();
  }

  public async uploadFile(id: string, file: File): Promise<void> {
    const form = new FormData();
    form.append('file', file);
    const res = await fetch(`/api/profiles/${id}/files`, {
      method: 'POST',
      body: form
    });
    if (res.ok) {
      // Refresh files for just this profile instead of all profiles
      await this.refreshProfileFiles(id);
    }
  }

  public async getFiles(id: string): Promise<string[]> {
    try {
      const res = await fetch(`/api/profiles/${id}/files`);
      if (res.ok) {
        const data = await res.json();
        return data.files || [];
      }
    } catch (err) {
      console.error('Failed to load profile files', err);
    }
    return [];
  }

  public async deleteFile(id: string, filename: string): Promise<void> {
    const res = await fetch(`/api/profiles/${id}/files/${filename}`, {
      method: 'DELETE'
    });
    if (res.ok) {
      // Refresh files for just this profile instead of all profiles
      await this.refreshProfileFiles(id);
    }
  }

  private async refreshProfileFiles(profileId: string): Promise<void> {
    const profile = this.profiles.find(p => p.id === profileId);
    if (profile) {
      profile.files = await this.getFiles(profileId);
      this.emit();
    }
  }

  public setActiveProfile(id: string | null) {
    this.activeProfile = id;
    if (id) localStorage.setItem('atlas_active_profile', id); else localStorage.removeItem('atlas_active_profile');
    this.emit();
  }
}

const profileManager = ProfileManager.getInstance();
export default profileManager;
