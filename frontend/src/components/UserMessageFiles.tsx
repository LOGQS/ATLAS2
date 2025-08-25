import React from 'react';
import '../styles/UserMessageFiles.css';

interface AttachedFile {
  id: string;
  name: string;
  size: number;
  type?: string;
  api_state?: string;
  provider?: string;
}

interface UserMessageFilesProps {
  files: AttachedFile[];
}

const getFileIcon = (filename: string): string => {
  const extension = filename.split('.').pop()?.toLowerCase() || '';
  
  if (['pdf'].includes(extension)) return '📄';
  if (['doc', 'docx'].includes(extension)) return '📝';
  if (['xls', 'xlsx'].includes(extension)) return '📊';
  if (['ppt', 'pptx'].includes(extension)) return '📋';
  
  if (['jpg', 'jpeg', 'png', 'gif', 'bmp', 'svg', 'webp'].includes(extension)) return '🖼️';
  
  if (['mp3', 'wav', 'flac', 'aac', 'ogg', 'm4a'].includes(extension)) return '🎵';
  
  if (['mp4', 'avi', 'mov', 'wmv', 'flv', 'webm', 'mkv'].includes(extension)) return '🎬';
  
  if (['zip', 'rar', '7z', 'tar', 'gz'].includes(extension)) return '🗜️';
  
  if (['js', 'jsx', 'ts', 'tsx', 'html', 'css', 'scss', 'json'].includes(extension)) return '💻';
  if (['py', 'java', 'cpp', 'c', 'cs', 'php', 'rb', 'go', 'rs'].includes(extension)) return '⚙️';
  
  if (['txt', 'md', 'rtf'].includes(extension)) return '📝';
  
  return '📎';
};

const formatFileSize = (bytes: number): string => {
  if (bytes === 0) return '0 Bytes';
  
  const k = 1024;
  const sizes = ['Bytes', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
};

const UserMessageFiles: React.FC<UserMessageFilesProps> = ({ files }) => {
  if (!files || files.length === 0) {
    return null;
  }

  // Create concatenated names for display
  const fileNames = files.map(file => file.name);
  const displayNames = fileNames.length > 3 
    ? `${fileNames.slice(0, 3).join(', ')} and ${fileNames.length - 3} more`
    : fileNames.join(', ');

  return (
    <div className="user-message-files">
      <div className="user-message-files-header">
        <div className="user-message-files-icon">📎</div>
        <div className="user-message-files-summary">
          <span className="file-count">{files.length} file{files.length !== 1 ? 's' : ''}</span>
          <span className="file-names" title={fileNames.join('\n')}>{displayNames}</span>
        </div>
      </div>
      
      <div className="user-message-files-grid">
        {files.map((file, index) => (
          <div key={index} className="user-message-file-item">
            <div className="file-icon">
              {getFileIcon(file.name)}
            </div>
            <div className="file-info">
              <div className="file-name" title={file.name}>
                {file.name.length > 20 ? `${file.name.substring(0, 20)}...` : file.name}
              </div>
              <div className="file-size">
                {formatFileSize(file.size)}
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
};

export default UserMessageFiles;