import { Redirect } from "expo-router";
import type { ReactElement } from "react";

export default function CaptureActionFallback(): ReactElement {
  return <Redirect href="/capture?source=mobile" />;
}
