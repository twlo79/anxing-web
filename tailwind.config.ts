import type { Config } from 'tailwindcss';
export default {
  content: ['./src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        mor: {
          bg: '#F1F0EC',
          line: '#E0DDD5',
          ink: '#2E3840',
          slate: '#41689B',     // 主色:更飽和的藍
          slatedark: '#345380',
          blue: '#4E96D1',      // 進度條藍(鮮豔)
          bluelight: '#DFEDFA',
          green: '#3FAE7C',     // 進度條綠(鮮豔)
          greenlight: '#DFF2E8',
          sand: '#ECE8DF',
        },
      },
    },
  },
  plugins: [],
} satisfies Config;
