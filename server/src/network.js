import os from 'node:os';

// Loopback, container bridges, VPN tunnels and Apple-internal links: not addresses other computers can reach.
const VIRTUAL_INTERFACE = /^(lo|docker|br-|veth|virbr|vmnet|vboxnet|utun|tun|tap|awdl|llw|bridge|gif|stf|anpi|ap\d)/;
const PRIVATE_IPV4 = /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/;

/** IPv4 addresses of this machine that other computers on the network can use, private LAN ranges first. */
export function lanAddresses() {
  const found = [];
  for (const [name, addresses] of Object.entries(os.networkInterfaces())) {
    if (VIRTUAL_INTERFACE.test(name)) continue;
    for (const address of addresses ?? []) {
      if (address.family === 'IPv4' && !address.internal) found.push(address.address);
    }
  }
  return [...new Set(found)].sort((a, b) => Number(PRIVATE_IPV4.test(b)) - Number(PRIVATE_IPV4.test(a)));
}

/** Whether a request comes from this machine itself (req.ip already resolves X-Forwarded-For through trust proxy). */
export const isLoopback = (ip) => /^(127\.|::1$|::ffff:127\.)/.test(ip ?? '');
