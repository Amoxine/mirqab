import type { Config } from 'tailwindcss';
import baseConfig from '@open-gateway/config/tailwind/base';

const config: Config = {
  ...baseConfig,
  content: [
    './src/**/*.{ts,tsx}',
    '../../packages/ui/src/**/*.{ts,tsx}',
  ],
  theme: {
    extend: {
      ...baseConfig.theme?.extend,
      colors: {
        ...baseConfig.theme?.extend?.colors,
        border: 'var(--color-border)',
        background: 'var(--color-background)',
        surface: 'var(--color-surface)',
      },
    },
  },
};

export default config;
