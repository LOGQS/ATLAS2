import { FC, useState } from 'react';
import {
  PdfLoader,
  PdfHighlighter,
  Highlight,
  Popup,
  IHighlight,
  NewHighlight
} from 'react-pdf-highlighter';
import 'react-pdf-highlighter/dist/style.css';
import '../styles/pdf-viewer.css';

interface PDFViewerProps {
  url: string;
  onClose: () => void;
}

const PDFViewer: FC<PDFViewerProps> = ({ url, onClose }) => {
  const [highlights, setHighlights] = useState<IHighlight[]>([]);

  const addHighlight = (highlight: NewHighlight) => {
    setHighlights((prev) => [{ ...highlight, id: String(Date.now()) }, ...prev]);
  };

  const renderHighlight = (
    highlight: IHighlight,
    index: number,
    setTip: (highlight: IHighlight, callback: (highlight: IHighlight) => JSX.Element) => void,
    hideTip: () => void
  ) => (
    <Popup
      key={index}
      popupContent={<div className="highlight-popup">{highlight.comment.text}</div>}
      onMouseOver={(popupContent) => setTip(highlight, () => popupContent)}
      onMouseOut={hideTip}
    >
      <Highlight position={highlight.position} comment={highlight.comment} />
    </Popup>
  );

  return (
    <div className="pdf-viewer-overlay" onClick={onClose}>
      <div className="pdf-viewer-container" onClick={(e) => e.stopPropagation()}>
        <button className="close-button pdf-close" onClick={onClose} aria-label="Close PDF viewer">
          ×
        </button>
        <PdfLoader url={url} beforeLoad={<div className="loading">Loading PDF...</div>}>
          {(pdfDocument) => (
            <PdfHighlighter
              pdfDocument={pdfDocument}
              enableAreaSelection={() => true}
              onSelectionFinished={(position, content, hideTip) => {
                const text = window.prompt('Add a note to this highlight:', '') || '';
                if (text.trim() !== '') {
                  addHighlight({ position, content, comment: { text, emoji: '' } });
                }
                hideTip();
                return null;
              }}
              highlightTransform={renderHighlight}
              highlights={highlights}
            />
          )}
        </PdfLoader>
      </div>
    </div>
  );
};

export default PDFViewer;
