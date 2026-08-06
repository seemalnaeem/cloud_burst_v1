import js from '@eslint/js'
import react from 'eslint-plugin-react'
import reactHooks from 'eslint-plugin-react-hooks'

export default [
  js.configs.recommended,
  {
    files: ['src/**/*.{js,jsx}'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      parserOptions: { ecmaFeatures: { jsx: true } },
      globals: {
        window: 'readonly',
        document: 'readonly',
        localStorage: 'readonly',
        fetch: 'readonly',
        AbortController: 'readonly',
        URL: 'readonly',
        URLSearchParams: 'readonly',
        console: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
        setInterval: 'readonly',
        clearInterval: 'readonly',
        navigator: 'readonly',
        matchMedia: 'readonly'
      }
    },
    settings: { react: { version: 'detect' } },
    plugins: { 'react-hooks': reactHooks, react },
    rules: {
      ...reactHooks.configs.recommended.rules,

      // Without these two, every component and every icon imported for JSX is
      // reported as an unused variable, because plain ESLint does not know that
      // <Foo /> is a use of Foo. That buried the two real errors in this file
      // under 57 false ones.
      'react/jsx-uses-react': 'error',
      'react/jsx-uses-vars': 'error',

      'no-unused-vars': ['warn', { argsIgnorePattern: '^_' }],

      // Lucide is banned by project rule. Icons come from react-icons.
      // See .claude/memory/frontend-toolchain.md.
      'no-restricted-imports': [
        'error',
        {
          paths: [
            {
              name: 'lucide-react',
              message: 'Lucide is not used in this project. Import from react-icons instead.'
            },
            {
              name: 'react-icons',
              message: 'Import from a specific set, for example react-icons/tb. The root import pulls in every family.'
            },
            {
              // react-icons ships Lucide as the "lu" set, so banning the
              // lucide-react package alone leaves the back door open.
              name: 'react-icons/lu',
              message: 'react-icons/lu is Lucide, which is banned. Use react-icons/tb or react-icons/fi.'
            }
          ]
        }
      ]
    }
  }
]
