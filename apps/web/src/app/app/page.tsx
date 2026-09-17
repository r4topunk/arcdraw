import type { Metadata } from "next";
import { RequestApp } from "./request-app";

export const metadata: Metadata = {
  title: "App",
  description: "Request drand-backed randomness on Arc mainnet, fulfill pending requests yourself and track refunds.",
};

export default function AppPage() {
  return <RequestApp />;
}
