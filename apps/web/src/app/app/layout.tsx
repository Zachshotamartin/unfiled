import type { ReactNode } from "react";

import { AuthGate } from "@/components/product/auth-gate";
import { DeskDock, DeskRail } from "@/components/product/desk-navigation";
import { PrivateSearchNavigationProvider } from "@/components/product/private-search-navigation";

export default function ProductLayout({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <AuthGate>
      <PrivateSearchNavigationProvider>
        <div className="product-shell">
          <DeskRail />
          <div className="min-w-0">{children}</div>
          <DeskDock />
        </div>
      </PrivateSearchNavigationProvider>
    </AuthGate>
  );
}
