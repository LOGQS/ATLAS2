import { FC, useEffect, useState } from 'react';

interface UrlPreviewData {
  title?: string;
  description?: string;
  image?: string;
  url: string;
}

interface UrlPreviewCardProps {
  url: string;
}

const UrlPreviewCard: FC<UrlPreviewCardProps> = ({ url }) => {
  const [data, setData] = useState<UrlPreviewData | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let isMounted = true;
    const fetchPreview = async () => {
      try {
        const response = await fetch(`/api/url-preview?url=${encodeURIComponent(url)}`);
        if (response.ok) {
          const json = await response.json();
          if (isMounted) {
            setData(json);
          }
        }
      } catch (err) {
        console.error('Failed to fetch URL preview', err);
      } finally {
        if (isMounted) {
          setLoading(false);
        }
      }
    };

    fetchPreview();
    return () => {
      isMounted = false;
    };
  }, [url]);

  if (loading) {
    return (
      <div className="url-preview-card loading">
        <div className="url-preview-content">Loading preview...</div>
      </div>
    );
  }

  if (!data) return null;

  return (
    <a href={data.url} className="url-preview-card" target="_blank" rel="noopener noreferrer">
      {data.image && (
        <img src={data.image} alt={data.title || 'Link image'} className="url-preview-image" />
      )}
      <div className="url-preview-content">
        {data.title && <div className="url-preview-title">{data.title}</div>}
        {data.description && (
          <div className="url-preview-description">{data.description}</div>
        )}
        <div className="url-preview-domain">{new URL(data.url).hostname}</div>
      </div>
    </a>
  );
};

export default UrlPreviewCard;
