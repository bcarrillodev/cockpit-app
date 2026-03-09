import type { CockpitApi } from "./contracts";

declare global {
  interface Window {
    cockpit: CockpitApi;
  }
}

export {};
