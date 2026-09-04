import path from 'path';
import { defineConfig, type ServerOptions, type UserConfig } from 'vite';
import react from '@vitejs/plugin-react'
import tailwindcss from "@tailwindcss/vite"

/**
 * Builds the dev server options.
 *
 * The proxy configuration lives in `./proxyOptions`, which resolves bench's
 * `sites/common_site_config.json`. That file is a development-only artefact, so
 * the module is imported lazily and only for `command === 'serve'` — a
 * production build must never depend on it. When no trustworthy backend port is
 * available `getProxyOptions()` warns and returns `undefined`; the dev server
 * then starts without a proxy instead of forwarding to a guessed port.
 */
async function serverOptions(command: 'build' | 'serve'): Promise<ServerOptions> {
	const server: ServerOptions = {
		port: 8080,
		host: '0.0.0.0'
	};

	if (command !== 'serve') {
		return server;
	}

	const { getProxyOptions } = await import('./proxyOptions.ts');
	const proxy = getProxyOptions();
	if (proxy) {
		server.proxy = proxy;
	}
	return server;
}

// https://vitejs.dev/config/
export default defineConfig(async ({ command }): Promise<UserConfig> => ({
	plugins: [react(), tailwindcss()],
	server: await serverOptions(command),
	resolve: {
		alias: {
			'@': path.resolve(import.meta.dirname, 'src')
		}
	},
	build: {
		outDir: '../erpnext/public/banking',
		emptyOutDir: true,
		target: 'es2015',
		rollupOptions: {
			output: {
				manualChunks(id) {
					if (!id.includes('node_modules')) {
						return
					}
					if (id.includes('react-dom') || id.includes('/react/')) {
						return 'vendor-react'
					}
					if (id.includes('frappe-react-sdk')) {
						return 'vendor-frappe'
					}
					if (id.includes('@tanstack')) {
						return 'vendor-tanstack'
					}
					if (id.includes('fuse.js')) {
						return 'vendor-fuse'
					}
					if (id.includes('radix-ui') || id.includes('@radix-ui')) {
						return 'vendor-radix'
					}
					if (id.includes('jotai')) {
						return 'vendor-jotai'
					}
					if (id.includes('lucide-react')) {
						return 'vendor-lucide'
					}
				},
			},
		},
	},
}));
