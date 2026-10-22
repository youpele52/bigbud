import { StatusBanner, type StatusBannerProps } from "../../common/StatusBanner";
import { CHAT_COLUMN_CLASS_NAME } from "./chatColumn";

/** Shared conversation width and a stable top-right close target; height follows content. */
export function ChatBanner(props: StatusBannerProps & { readonly onDismiss: () => void }) {
  return (
    <div className={`${CHAT_COLUMN_CLASS_NAME} shrink-0 px-3 pt-3 sm:px-5`} data-chat-banner>
      <StatusBanner
        {...props}
        dismissPlacement="corner"
        className={`pr-11 ${props.className ?? ""}`}
      />
    </div>
  );
}
