import type { ReactNode } from "react";

import { AuthGate } from "@/components/product/auth-gate";
import { DesktopAppNavigation, MobileAppNavigation } from "@/components/product/app-navigation";
import { PrivateSearchNavigationProvider } from "@/components/product/private-search-navigation";

export default function ProductLayout({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <AuthGate>
      <PrivateSearchNavigationProvider>
        <div className="product-shell">
          <DesktopAppNavigation />
          <div className="min-w-0">{children}</div>
          <MobileAppNavigation />
        </div>
      </PrivateSearchNavigationProvider>
    </AuthGate>
  );
}
