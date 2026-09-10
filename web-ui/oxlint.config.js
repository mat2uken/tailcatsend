import config from '@nkzw/oxlint-config';

export default {
  ...config,
  rules: {
    ...config.rules,
    // UI object literals are intentionally ordered for readability.
    'perfectionist/sort-objects': 'off',
    'perfectionist/sort-object-types': 'off',
    // Browser adapters report errors through the visible UI.
    'no-console': 'off',
    'unicorn/prefer-node-protocol': 'off',
    'unicorn/numeric-separators-style': 'off',
    // Keep startup compatible with ES2018 WebViews; do not suspend module evaluation.
    'unicorn/prefer-top-level-await': 'off',
  },
};
