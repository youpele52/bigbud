import { ChatGreetingSurface } from "@bigbud/ui/chatGreetingSurface";

import { BigbudLogo } from "../../sidebar/SidebarProjectItem";

export function ChatGreeting(props: { greeting?: string | null; shimmer?: boolean }) {
  return <ChatGreetingSurface Logo={BigbudLogo} {...props} />;
}
