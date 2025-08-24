import React, { useMemo } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkMath from 'remark-math';
import rehypeKatex from 'rehype-katex';
import 'katex/dist/katex.min.css';

interface MessageRendererProps {
  content: string;
  className?: string;
  showCursor?: boolean;
}

const MessageRenderer: React.FC<MessageRendererProps> = ({ 
  content, 
  className = '', 
  showCursor = false 
}) => {
  const processedContent = useMemo(() => {
    if (!content) return '';
    
    // Handle streaming - if content ends mid-LaTeX, don't render the incomplete part
    const lines = content.split('\n');
    const processedLines: string[] = [];
    
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      
      // Check for incomplete inline math (single $ without closing)
      const inlineMathMatches = line.match(/\$/g);
      if (inlineMathMatches && inlineMathMatches.length % 2 !== 0 && i === lines.length - 1) {
        // Last line with incomplete inline math - don't include the incomplete part
        const lastDollarIndex = line.lastIndexOf('$');
        processedLines.push(line.substring(0, lastDollarIndex));
        break;
      }
      
      // Check for incomplete block math ($$)
      if (line.includes('$$') && i === lines.length - 1) {
        const blockMathMatches = line.match(/\$\$/g);
        if (blockMathMatches && blockMathMatches.length % 2 !== 0) {
          // Incomplete block math - don't include it
          const lastBlockMathIndex = line.lastIndexOf('$$');
          processedLines.push(line.substring(0, lastBlockMathIndex));
          break;
        }
      }
      
      processedLines.push(line);
    }
    
    return processedLines.join('\n');
  }, [content]);

  return (
    <div className={`message-renderer ${className}`}>
      <ReactMarkdown
        remarkPlugins={[remarkMath]}
        rehypePlugins={[rehypeKatex]}
        components={{
          // Customize rendering for specific elements
          p: ({ children }) => <p className="markdown-paragraph">{children}</p>,
          code: ({ className, children, ...props }: any) => {
            const isInline = !String(children).includes('\n');
            if (isInline) {
              return <code className="markdown-inline-code" {...props}>{children}</code>;
            }
            return (
              <pre className="markdown-code-block">
                <code className={className} {...props}>{children}</code>
              </pre>
            );
          },
          blockquote: ({ children }) => (
            <blockquote className="markdown-blockquote">{children}</blockquote>
          ),
          ul: ({ children }) => <ul className="markdown-list">{children}</ul>,
          ol: ({ children }) => <ol className="markdown-ordered-list">{children}</ol>,
          li: ({ children }) => <li className="markdown-list-item">{children}</li>,
          h1: ({ children }) => <h1 className="markdown-h1">{children}</h1>,
          h2: ({ children }) => <h2 className="markdown-h2">{children}</h2>,
          h3: ({ children }) => <h3 className="markdown-h3">{children}</h3>,
          h4: ({ children }) => <h4 className="markdown-h4">{children}</h4>,
          h5: ({ children }) => <h5 className="markdown-h5">{children}</h5>,
          h6: ({ children }) => <h6 className="markdown-h6">{children}</h6>,
          table: ({ children }) => (
            <div className="markdown-table-wrapper">
              <table className="markdown-table">{children}</table>
            </div>
          ),
          th: ({ children }) => <th className="markdown-table-header">{children}</th>,
          td: ({ children }) => <td className="markdown-table-cell">{children}</td>,
          a: ({ href, children }) => (
            <a 
              href={href} 
              className="markdown-link" 
              target="_blank" 
              rel="noopener noreferrer"
            >
              {children}
            </a>
          ),
          strong: ({ children }) => <strong className="markdown-bold">{children}</strong>,
          em: ({ children }) => <em className="markdown-italic">{children}</em>,
        }}
      >
        {processedContent}
      </ReactMarkdown>
      {showCursor && <span className="cursor">|</span>}
    </div>
  );
};

export default MessageRenderer;