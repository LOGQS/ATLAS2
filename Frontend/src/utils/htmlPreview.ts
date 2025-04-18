// Create a custom event for showing HTML preview
export type ShowHtmlPreviewEvent = CustomEvent<{
  html: string;
}>;

// Declare the event for TypeScript
declare global {
  interface WindowEventMap {
    'show-html-preview': ShowHtmlPreviewEvent;
  }
}

// Helper function to show HTML preview from anywhere
export function showHtmlPreview(html: string): void {
  const event = new CustomEvent('show-html-preview', {
    detail: { html }
  });
  window.dispatchEvent(event);
} 