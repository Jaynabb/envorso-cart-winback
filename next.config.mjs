/** @type {import('next').NextConfig} */
const nextConfig = {
  // A production build writes over .next while `next dev` is using it, which
  // leaves the running dev server loading half-replaced chunks and throwing
  // "Cannot find module './331.js'". Twice in one afternoon. So the build gets
  // its own directory and the two can't collide: `npm run build` is safe to run
  // with the dev server up.
  distDir: process.env.NEXT_DIST_DIR || ".next",
};

export default nextConfig;
