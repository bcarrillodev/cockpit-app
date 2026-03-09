/// <reference types="vite/client" />

import type { CockpitApi } from "../shared/contracts";

declare global {
  interface Window {
    cockpit: CockpitApi;
  }
}

export {};
