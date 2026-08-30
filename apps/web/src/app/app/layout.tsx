import type { ReactNode } from "react";

import { AuthGate } from "@/components/product/auth-gate";
import { DesktopAppNavigation, MobileAppNavigation } from "@/components/product/app-navigation";

export default function ProductLayout({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <AuthGate>
      <div className="product-shell">
        <DesktopAppNavigation />
        <div className="min-w-0">{children}</div>
        <MobileAppNavigation />
      </div>
    </AuthGate>
  );
}
