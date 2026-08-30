import { Redirect } from "expo-router";
import type { ReactElement } from "react";

export default function AuthIndex(): ReactElement {
  return <Redirect href="/(auth)/sign-in" />;
}
