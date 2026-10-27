import { createApp } from './app';
const app = createApp({ localDevelopment: import.meta.env.DEV });
export default { fetch: app.fetch };
