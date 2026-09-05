/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: false, // the voice session is a long-lived singleton; double-mount would open two mics
  eslint: { ignoreDuringBuilds: true },
};
export default nextConfig;
