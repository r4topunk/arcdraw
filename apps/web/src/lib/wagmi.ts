import { createConfig, http } from "wagmi";
import { injected } from "wagmi/connectors";
import { ARC_RPC_URL, arcMainnet } from "./chain";

export const wagmiConfig = createConfig({
  chains: [arcMainnet],
  connectors: [injected()],
  transports: { [arcMainnet.id]: http(ARC_RPC_URL, { batch: true }) },
  ssr: true,
});

declare module "wagmi" {
  interface Register {
    config: typeof wagmiConfig;
  }
}
