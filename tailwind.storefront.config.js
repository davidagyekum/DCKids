/** @type {import('tailwindcss').Config} */
module.exports = {
  content: {
    relative: true,
    files: ['./index.html', './app.js']
  },
  theme: {
    extend: {
      fontFamily: {
        sans: ['Inter', 'sans-serif'],
        serif: ['Playfair Display', 'serif']
      },
      colors: {
        brand: {
          green: '#5E9C7E',
          darkgreen: '#0F4C3A',
          bg: '#FAFAF8',
          pink: '#FCECEC'
        }
      }
    }
  },
  plugins: []
};