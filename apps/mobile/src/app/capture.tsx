import { useLocalSearchParams } from "expo-router";
import type { ReactElement } from "react";

import { CaptureComposer } from "../features/capture/CaptureComposer";
import { allowlistedCaptureSource } from "../features/capture/captureSource";

export default function CaptureRoute(): ReactElement {
  const parameters = useLocalSearchParams<{ source?: string | string[] }>();
  const source = allowlistedCaptureSource(parameters.source);
  return <CaptureComposer source={source} />;
}
