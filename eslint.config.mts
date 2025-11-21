import eslint from '@eslint/js'
import prettier from 'eslint-plugin-prettier/recommended'
import tseslint from 'typescript-eslint'

export default tseslint.config(eslint.configs.recommended, tseslint.configs.recommended, prettier, {
    files: ['**/*.ts', '**/*.js'],
    rules: {
        '@typescript-eslint/consistent-type-imports': 'error',
        '@typescript-eslint/no-for-in-array': 'error',
        '@typescript-eslint/no-unsafe-function-type': 'off'
    }
})
