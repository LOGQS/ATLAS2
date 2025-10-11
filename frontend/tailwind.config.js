/** @type {import('tailwindcss').Config} */
module.exports = {
  content: [
    "./src/**/*.{js,jsx,ts,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        'bolt-elements': {
          'borderColor': 'var(--bolt-elements-borderColor)',
          'borderColorActive': 'var(--bolt-elements-borderColorActive)',
          'bg-depth-1': 'var(--bolt-elements-bg-depth-1)',
          'bg-depth-2': 'var(--bolt-elements-bg-depth-2)',
          'bg-depth-3': 'var(--bolt-elements-bg-depth-3)',
          'background-depth-1': 'var(--bolt-elements-background-depth-1)',
          'background-depth-2': 'var(--bolt-elements-background-depth-2)',
          'background-depth-3': 'var(--bolt-elements-background-depth-3)',
          'textPrimary': 'var(--bolt-elements-textPrimary)',
          'textSecondary': 'var(--bolt-elements-textSecondary)',
          'textTertiary': 'var(--bolt-elements-textTertiary)',
          'item-contentDefault': 'var(--bolt-elements-item-contentDefault)',
          'item-contentActive': 'var(--bolt-elements-item-contentActive)',
          'item-contentAccent': 'var(--bolt-elements-item-contentAccent)',
          'item-contentDanger': 'var(--bolt-elements-item-contentDanger)',
          'item-backgroundDefault': 'var(--bolt-elements-item-backgroundDefault)',
          'item-backgroundActive': 'var(--bolt-elements-item-backgroundActive)',
          'item-backgroundAccent': 'var(--bolt-elements-item-backgroundAccent)',
          'item-backgroundDanger': 'var(--bolt-elements-item-backgroundDanger)',
        },
        'accent': {
          '500': 'var(--accent-500)',
        },
      },
      textColor: {
        'bolt-elements-textPrimary': 'var(--bolt-elements-textPrimary)',
        'bolt-elements-textSecondary': 'var(--bolt-elements-textSecondary)',
        'bolt-elements-textTertiary': 'var(--bolt-elements-textTertiary)',
        'bolt-elements-item-contentDefault': 'var(--bolt-elements-item-contentDefault)',
        'bolt-elements-item-contentActive': 'var(--bolt-elements-item-contentActive)',
        'bolt-elements-item-contentAccent': 'var(--bolt-elements-item-contentAccent)',
        'bolt-elements-item-contentDanger': 'var(--bolt-elements-item-contentDanger)',
      },
      backgroundColor: {
        'bolt-elements-bg-depth-1': 'var(--bolt-elements-bg-depth-1)',
        'bolt-elements-background-depth-1': 'var(--bolt-elements-background-depth-1)',
        'bolt-elements-bg-depth-2': 'var(--bolt-elements-bg-depth-2)',
        'bolt-elements-background-depth-2': 'var(--bolt-elements-background-depth-2)',
        'bolt-elements-bg-depth-3': 'var(--bolt-elements-bg-depth-3)',
        'bolt-elements-background-depth-3': 'var(--bolt-elements-background-depth-3)',
        'bolt-elements-item-backgroundDefault': 'var(--bolt-elements-item-backgroundDefault)',
        'bolt-elements-item-backgroundActive': 'var(--bolt-elements-item-backgroundActive)',
        'bolt-elements-item-backgroundAccent': 'var(--bolt-elements-item-backgroundAccent)',
        'bolt-elements-item-backgroundDanger': 'var(--bolt-elements-item-backgroundDanger)',
      },
      borderColor: {
        'bolt-elements-borderColor': 'var(--bolt-elements-borderColor)',
        'bolt-elements-borderColorActive': 'var(--bolt-elements-borderColorActive)',
      },
    },
  },
  plugins: [],
  corePlugins: {
    preflight: false,
  },
}
