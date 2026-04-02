/** @type {import('tailwindcss').Config} */
module.exports = {
    content: [
        "./src/pages/**/*.{js,ts,jsx,tsx,mdx}",
        "./src/components/**/*.{js,ts,jsx,tsx,mdx}",
        "./src/app/**/*.{js,ts,jsx,tsx,mdx}",
    ],
    theme: {
        extend: {
            colors: {
                hui: {
                    primary: '#4c9a2a',
                    primaryHover: '#3e8022',
                    background: '#f8f9fa',
                    sidebar: '#1e1e1e',
                    textMain: '#222222',
                    textMuted: '#666666',
                    border: '#e1e4e8',
                }
            }
        },
    },
    plugins: [],
};
