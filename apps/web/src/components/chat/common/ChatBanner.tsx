import { StatusBanner, type StatusBannerProps } from "../../common/StatusBanner";

/** Shared conversation width and a stable top-right close target; height follows content. */
export function ChatBanner(props: StatusBannerProps & { readonly onDismiss: () => void }) {
  return (
    <div className="mx-auto w-full max-w-3xl shrink-0 px-3 pt-3 sm:px-5" data-chat-banner>
      <StatusBanner
        {...props}
        dismissPlacement="corner"
        className={`pr-11 ${props.className ?? ""}`}
      />
    </div>
  );
}
