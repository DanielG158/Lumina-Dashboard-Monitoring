import { createContext, useContext } from "react";
import type { ActiveAlert, ActiveMaintenance, AlertsPayload, AuthStatus, InstanceUpdate, MaintenanceStatus, ModuleInfo, Role } from "./api";

export interface Can {
  operate: boolean;
  admin: boolean;
}

export interface Lumina {
  auth: AuthStatus | null;
  role: Role;
  can: Can;
  modules: ModuleInfo[];
  instances: InstanceUpdate[];
  alerts: AlertsPayload;
  alertsFor: (instanceId: string) => ActiveAlert[];
  maintenance: MaintenanceStatus | null;
  maintenanceFor: (instanceId: string) => ActiveMaintenance | null;
  reloadMaintenance: () => Promise<void>;
  connected: boolean;
  notify: (msg: string, bad?: boolean) => void;
  reloadAuth: () => Promise<void>;
  reloadAlerts: () => Promise<void>;
  reloadInstances: () => Promise<void>;
  requireLogin: () => void;
  go: (tab: string) => void;
  edit: (instanceId: string) => void;
  startAdding: () => void;
}

export const LuminaContext = createContext<Lumina | null>(null);

export function useLumina(): Lumina {
  const ctx = useContext(LuminaContext);
  if (!ctx) throw new Error("useLumina must be used inside <LuminaContext.Provider>");
  return ctx;
}

export const roleOf = (auth: AuthStatus | null): Role => auth?.user?.role ?? (auth?.openAccess ? "admin" : "viewer");
export const canOf = (role: Role): Can => ({ operate: role === "operator" || role === "admin", admin: role === "admin" });
