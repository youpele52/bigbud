import { useId } from "react";
import { type Icon } from "./Icons";

export const VisualStudioCode: Icon = (props) => {
  const id = useId();
  const maskId = `${id}-vscode-a`;
  const topShadowFilterId = `${id}-vscode-b`;
  const sideShadowFilterId = `${id}-vscode-c`;
  const overlayGradientId = `${id}-vscode-d`;

  return (
    <svg {...props} fill="none" viewBox="0 0 100 100">
      <mask id={maskId} width="100" height="100" x="0" y="0" maskUnits="userSpaceOnUse">
        <path
          fill="#fff"
          fillRule="evenodd"
          d="M70.912 99.317a6.223 6.223 0 0 0 4.96-.19l20.589-9.907A6.25 6.25 0 0 0 100 83.587V16.413a6.25 6.25 0 0 0-3.54-5.632L75.874.874a6.226 6.226 0 0 0-7.104 1.21L29.355 38.04 12.187 25.01a4.162 4.162 0 0 0-5.318.236l-5.506 5.009a4.168 4.168 0 0 0-.004 6.162L16.247 50 1.36 63.583a4.168 4.168 0 0 0 .004 6.162l5.506 5.01a4.162 4.162 0 0 0 5.318.236l17.168-13.032L68.77 97.917a6.217 6.217 0 0 0 2.143 1.4ZM75.015 27.3 45.11 50l29.906 22.701V27.3Z"
          clipRule="evenodd"
        />
      </mask>
      <g mask={`url(#${maskId})`}>
        <path
          fill="#0065A9"
          d="M96.461 10.796 75.857.876a6.23 6.23 0 0 0-7.107 1.207l-67.451 61.5a4.167 4.167 0 0 0 .004 6.162l5.51 5.009a4.167 4.167 0 0 0 5.32.236l81.228-61.62c2.725-2.067 6.639-.124 6.639 3.297v-.24a6.25 6.25 0 0 0-3.539-5.63Z"
        />
        <g filter={`url(#${topShadowFilterId})`}>
          <path
            fill="#007ACC"
            d="m96.461 89.204-20.604 9.92a6.229 6.229 0 0 1-7.107-1.207l-67.451-61.5a4.167 4.167 0 0 1 .004-6.162l5.51-5.009a4.167 4.167 0 0 1 5.32-.236l81.228 61.62c2.725 2.067 6.639.124 6.639-3.297v.24a6.25 6.25 0 0 1-3.539 5.63Z"
          />
        </g>
        <g filter={`url(#${sideShadowFilterId})`}>
          <path
            fill="#1F9CF0"
            d="M75.858 99.126a6.232 6.232 0 0 1-7.108-1.21c2.306 2.307 6.25.674 6.25-2.588V4.672c0-3.262-3.944-4.895-6.25-2.589a6.232 6.232 0 0 1 7.108-1.21l20.6 9.908A6.25 6.25 0 0 1 100 16.413v67.174a6.25 6.25 0 0 1-3.541 5.633l-20.601 9.906Z"
          />
        </g>
        <path
          fill={`url(#${overlayGradientId})`}
          fillRule="evenodd"
          d="M70.851 99.317a6.224 6.224 0 0 0 4.96-.19L96.4 89.22a6.25 6.25 0 0 0 3.54-5.633V16.413a6.25 6.25 0 0 0-3.54-5.632L75.812.874a6.226 6.226 0 0 0-7.104 1.21L29.294 38.04 12.126 25.01a4.162 4.162 0 0 0-5.317.236l-5.507 5.009a4.168 4.168 0 0 0-.004 6.162L16.186 50 1.298 63.583a4.168 4.168 0 0 0 .004 6.162l5.507 5.009a4.162 4.162 0 0 0 5.317.236L29.294 61.96l39.414 35.958a6.218 6.218 0 0 0 2.143 1.4ZM74.954 27.3 45.048 50l29.906 22.701V27.3Z"
          clipRule="evenodd"
          opacity=".25"
          style={{ mixBlendMode: "overlay" }}
        />
      </g>
      <defs>
        <filter
          id={topShadowFilterId}
          width="116.727"
          height="92.246"
          x="-8.394"
          y="15.829"
          colorInterpolationFilters="sRGB"
          filterUnits="userSpaceOnUse"
        >
          <feFlood floodOpacity="0" result="BackgroundImageFix" />
          <feColorMatrix in="SourceAlpha" values="0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 127 0" />
          <feOffset />
          <feGaussianBlur stdDeviation="4.167" />
          <feColorMatrix values="0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0.25 0" />
          <feBlend in2="BackgroundImageFix" mode="overlay" result="effect1_dropShadow" />
          <feBlend in="SourceGraphic" in2="effect1_dropShadow" result="shape" />
        </filter>
        <filter
          id={sideShadowFilterId}
          width="47.917"
          height="116.151"
          x="60.417"
          y="-8.076"
          colorInterpolationFilters="sRGB"
          filterUnits="userSpaceOnUse"
        >
          <feFlood floodOpacity="0" result="BackgroundImageFix" />
          <feColorMatrix in="SourceAlpha" values="0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 127 0" />
          <feOffset />
          <feGaussianBlur stdDeviation="4.167" />
          <feColorMatrix values="0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0.25 0" />
          <feBlend in2="BackgroundImageFix" mode="overlay" result="effect1_dropShadow" />
          <feBlend in="SourceGraphic" in2="effect1_dropShadow" result="shape" />
        </filter>
        <linearGradient
          id={overlayGradientId}
          x1="49.939"
          x2="49.939"
          y1=".258"
          y2="99.742"
          gradientUnits="userSpaceOnUse"
        >
          <stop stopColor="#fff" />
          <stop offset="1" stopColor="#fff" stopOpacity="0" />
        </linearGradient>
      </defs>
    </svg>
  );
};

export const VisualStudioCodeInsiders: Icon = (props) => {
  const id = useId();
  const maskId = `${id}-vscode-insiders-a`;
  const topShadowFilterId = `${id}-vscode-insiders-b`;
  const sideShadowFilterId = `${id}-vscode-insiders-c`;
  const overlayGradientId = `${id}-vscode-insiders-d`;

  return (
    <svg {...props} fill="none" viewBox="0 0 100 100">
      <mask id={maskId} width="100" height="100" x="0" y="0" maskUnits="userSpaceOnUse">
        <path
          fill="#fff"
          fillRule="evenodd"
          d="M70.912 99.317a6.223 6.223 0 0 0 4.96-.19l20.589-9.907A6.25 6.25 0 0 0 100 83.587V16.413a6.25 6.25 0 0 0-3.54-5.632L75.874.874a6.226 6.226 0 0 0-7.104 1.21L29.355 38.04 12.187 25.01a4.162 4.162 0 0 0-5.318.236l-5.506 5.009a4.168 4.168 0 0 0-.004 6.162L16.247 50 1.36 63.583a4.168 4.168 0 0 0 .004 6.162l5.506 5.01a4.162 4.162 0 0 0 5.318.236l17.168-13.032L68.77 97.917a6.217 6.217 0 0 0 2.143 1.4ZM75.015 27.3 45.11 50l29.906 22.701V27.3Z"
          clipRule="evenodd"
        />
      </mask>
      <g mask={`url(#${maskId})`}>
        <path
          fill="#009a7c"
          d="M96.461 10.796 75.857.876a6.23 6.23 0 0 0-7.107 1.207l-67.451 61.5a4.167 4.167 0 0 0 .004 6.162l5.51 5.009a4.167 4.167 0 0 0 5.32.236l81.228-61.62c2.725-2.067 6.639-.124 6.639 3.297v-.24a6.25 6.25 0 0 0-3.539-5.63Z"
        />
        <g filter={`url(#${topShadowFilterId})`}>
          <path
            fill="#00b294"
            d="m96.461 89.204-20.604 9.92a6.229 6.229 0 0 1-7.107-1.207l-67.451-61.5a4.167 4.167 0 0 1 .004-6.162l5.51-5.009a4.167 4.167 0 0 1 5.32-.236l81.228 61.62c2.725 2.067 6.639.124 6.639-3.297v.24a6.25 6.25 0 0 1-3.539 5.63Z"
          />
        </g>
        <g filter={`url(#${sideShadowFilterId})`}>
          <path
            fill="#24bfa5"
            d="M75.858 99.126a6.232 6.232 0 0 1-7.108-1.21c2.306 2.307 6.25.674 6.25-2.588V4.672c0-3.262-3.944-4.895-6.25-2.589a6.232 6.232 0 0 1 7.108-1.21l20.6 9.908A6.25 6.25 0 0 1 100 16.413v67.174a6.25 6.25 0 0 1-3.541 5.633l-20.601 9.906Z"
          />
        </g>
        <path
          fill={`url(#${overlayGradientId})`}
          fillRule="evenodd"
          d="M70.851 99.317a6.224 6.224 0 0 0 4.96-.19L96.4 89.22a6.25 6.25 0 0 0 3.54-5.633V16.413a6.25 6.25 0 0 0-3.54-5.632L75.812.874a6.226 6.226 0 0 0-7.104 1.21L29.294 38.04 12.126 25.01a4.162 4.162 0 0 0-5.317.236l-5.507 5.009a4.168 4.168 0 0 0-.004 6.162L16.186 50 1.298 63.583a4.168 4.168 0 0 0 .004 6.162l5.507 5.009a4.162 4.162 0 0 0 5.317.236L29.294 61.96l39.414 35.958a6.218 6.218 0 0 0 2.143 1.4ZM74.954 27.3 45.048 50l29.906 22.701V27.3Z"
          clipRule="evenodd"
          opacity=".25"
          style={{ mixBlendMode: "overlay" }}
        />
      </g>
      <defs>
        <filter
          id={topShadowFilterId}
          width="116.727"
          height="92.246"
          x="-8.394"
          y="15.829"
          colorInterpolationFilters="sRGB"
          filterUnits="userSpaceOnUse"
        >
          <feFlood floodOpacity="0" result="BackgroundImageFix" />
          <feColorMatrix in="SourceAlpha" values="0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 127 0" />
          <feOffset />
          <feGaussianBlur stdDeviation="4.167" />
          <feColorMatrix values="0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0.25 0" />
          <feBlend in2="BackgroundImageFix" mode="overlay" result="effect1_dropShadow" />
          <feBlend in="SourceGraphic" in2="effect1_dropShadow" result="shape" />
        </filter>
        <filter
          id={sideShadowFilterId}
          width="47.917"
          height="116.151"
          x="60.417"
          y="-8.076"
          colorInterpolationFilters="sRGB"
          filterUnits="userSpaceOnUse"
        >
          <feFlood floodOpacity="0" result="BackgroundImageFix" />
          <feColorMatrix in="SourceAlpha" values="0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 127 0" />
          <feOffset />
          <feGaussianBlur stdDeviation="4.167" />
          <feColorMatrix values="0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0.25 0" />
          <feBlend in2="BackgroundImageFix" mode="overlay" result="effect1_dropShadow" />
          <feBlend in="SourceGraphic" in2="effect1_dropShadow" result="shape" />
        </filter>
        <linearGradient
          id={overlayGradientId}
          x1="49.939"
          x2="49.939"
          y1=".258"
          y2="99.742"
          gradientUnits="userSpaceOnUse"
        >
          <stop stopColor="#fff" />
          <stop offset="1" stopColor="#fff" stopOpacity="0" />
        </linearGradient>
      </defs>
    </svg>
  );
};

export const VSCodium: Icon = (props) => {
  const id = useId();
  const gradientId = `${id}-vscodium-gradient`;

  return (
    <svg {...props} viewBox="0 0 100 100">
      <defs>
        <linearGradient
          id={gradientId}
          x1="0"
          x2="100"
          y1="0"
          y2="100"
          gradientUnits="userSpaceOnUse"
        >
          <stop offset="0" stopColor="#62A0EA" />
          <stop offset="1" stopColor="#1A5FB4" />
        </linearGradient>
      </defs>
      <path
        fill={`url(#${gradientId})`}
        d="M48.26 2.274C45.406 4.105 44.583 7.898 46.422 10.742C56.531 26.397 58.917 38.205 57.882 48.553C53.698 68.369 44.603 72.389 36.655 72.389C28.895 72.389 30.973 59.618 36.806 55.88C40.288 53.706 44.748 52.293 48.171 52.293C51.563 52.293 54.313 49.552 54.313 46.17C54.313 42.787 51.563 40.046 48.171 40.046C44.173 40.046 40.251 40.886 36.59 42.316C37.338 38.787 37.614 34.973 36.647 30.919C35.179 24.763 30.953 18.883 23.615 13.183C22.33 12.183 20.7 11.734 19.083 11.934C17.466 12.134 15.995 12.966 14.994 14.248C12.912 16.918 13.394 20.766 16.072 22.843C22.05 27.486 24.024 30.923 24.699 33.752C25.374 36.581 24.831 39.616 23.475 43.786C21.742 49.406 19.73 54.423 18.848 59.234C18.414 61.602 18.377 64.179 18.265 66.238C13.96 62.042 12.275 56.502 12.275 48.407C12.274 45.025 9.524 42.283 6.133 42.284C2.744 42.287-0.002 45.027-0.003 48.407C-0.003 59.463 3.23 69.983 11.895 77.001C19.739 84.474 39.686 81.712 39.686 93.709C39.686 97.095 44.642 98.743 48.033 98.743C51.511 98.743 55.888 96.418 55.888 93.709C55.888 80.097 70.233 71.824 93.848 71.86C97.24 71.865 99.992 69.126 99.997 65.744C100.003 62.361 97.259 59.614 93.867 59.608C92.252 59.606 90.678 59.661 89.126 59.753C91.766 53.544 92.937 46.708 92.695 39.324C92.583 35.943 89.745 33.293 86.356 33.403C82.963 33.513 80.305 36.346 80.416 39.729C80.736 49.397 80.374 58.03 73.171 62.581C71.123 63.874 68.742 64.996 66.484 64.996C68.237 60.228 69.561 55.195 70.103 49.77C70.449 46.308 70.486 42.195 70.091 39C69.478 34.05 68.738 28.436 70.617 24.207C72.305 20.565 76.087 19.04 81.64 19.04C85.029 19.037 87.775 16.296 87.776 12.917C87.778 9.534 85.031 6.79 81.64 6.787C73.388 6.787 67.133 11.13 63.587 16.377C61.733 12.417 59.475 8.336 56.747 4.112C55.866 2.747 54.478 1.788 52.887 1.443C52.099 1.272 51.285 1.257 50.491 1.399C49.697 1.542 48.939 1.839 48.26 2.274z"
      />
    </svg>
  );
};

export const IntelliJIdeaIcon: Icon = (props) => {
  const id = useId();
  const gradientAId = `${id}-idea-a`;
  const gradientBId = `${id}-idea-b`;
  const gradientCId = `${id}-idea-c`;
  const gradientDId = `${id}-idea-d`;

  return (
    <svg {...props} viewBox="0 0 70 70" fill="none">
      <defs>
        <linearGradient
          id={gradientAId}
          x1="0.7898"
          y1="40.0893"
          x2="33.3172"
          y2="40.0893"
          gradientUnits="userSpaceOnUse"
        >
          <stop offset="0.2581" stopColor="#F97A12" />
          <stop offset="0.4591" stopColor="#B07B58" />
          <stop offset="0.7241" stopColor="#577BAE" />
          <stop offset="0.9105" stopColor="#1E7CE5" />
          <stop offset="1" stopColor="#087CFA" />
        </linearGradient>
        <linearGradient
          id={gradientBId}
          x1="25.7674"
          y1="24.88"
          x2="79.424"
          y2="54.57"
          gradientUnits="userSpaceOnUse"
        >
          <stop stopColor="#F97A12" />
          <stop offset="0.07179946" stopColor="#CB7A3E" />
          <stop offset="0.1541" stopColor="#9E7B6A" />
          <stop offset="0.242" stopColor="#757B91" />
          <stop offset="0.3344" stopColor="#537BB1" />
          <stop offset="0.4324" stopColor="#387CCC" />
          <stop offset="0.5381" stopColor="#237CE0" />
          <stop offset="0.6552" stopColor="#147CEF" />
          <stop offset="0.7925" stopColor="#0B7CF7" />
          <stop offset="1" stopColor="#087CFA" />
        </linearGradient>
        <linearGradient
          id={gradientCId}
          x1="63.2277"
          y1="42.9153"
          x2="48.2903"
          y2="-1.7191"
          gradientUnits="userSpaceOnUse"
        >
          <stop stopColor="#FE315D" />
          <stop offset="0.07840246" stopColor="#CB417E" />
          <stop offset="0.1601" stopColor="#9E4E9B" />
          <stop offset="0.2474" stopColor="#755BB4" />
          <stop offset="0.3392" stopColor="#5365CA" />
          <stop offset="0.4365" stopColor="#386DDB" />
          <stop offset="0.5414" stopColor="#2374E9" />
          <stop offset="0.6576" stopColor="#1478F3" />
          <stop offset="0.794" stopColor="#0B7BF8" />
          <stop offset="1" stopColor="#087CFA" />
        </linearGradient>
        <linearGradient
          id={gradientDId}
          x1="10.7204"
          y1="16.473"
          x2="55.5237"
          y2="90.58"
          gradientUnits="userSpaceOnUse"
        >
          <stop stopColor="#FE315D" />
          <stop offset="0.04023279" stopColor="#F63462" />
          <stop offset="0.1037" stopColor="#DF3A71" />
          <stop offset="0.1667" stopColor="#C24383" />
          <stop offset="0.2912" stopColor="#AD4A91" />
          <stop offset="0.5498" stopColor="#755BB4" />
          <stop offset="0.9175" stopColor="#1D76ED" />
          <stop offset="1" stopColor="#087CFA" />
        </linearGradient>
      </defs>
      <polygon points="17.7,54.6 0.8,41.2 9.2,25.6 33.3,35" fill={`url(#${gradientAId})`} />
      <path
        d="M70 18.7 68.7 59.2 41.8 70 25.6 59.6 49.3 35 38.9 12.3 48.2 1.1Z"
        fill={`url(#${gradientBId})`}
      />
      <polygon points="70,18.7 48.7,43.9 38.9,12.3 48.2,1.1" fill={`url(#${gradientCId})`} />
      <path
        d="M33.7 58.1 5.6 68.3 10.1 52.5 16 33.1 0 27.7 10.1 0 32.1 2.7 53.7 27.4Z"
        fill={`url(#${gradientDId})`}
      />
      <rect x="13.7" y="13.5" width="43.2" height="43.2" fill="#000" />
      <rect x="17.7" y="48.6" width="16.2" height="2.7" fill="#fff" />
      <path d="M29.4 22.4v-3.3h-9v3.3h2.6v11.3h-2.6V37h9v-3.3h-2.5V22.4h2.5Z" fill="#fff" />
      <path
        d="M38 37.3c-1.4 0-2.6-.3-3.5-.8-.9-.5-1.7-1.2-2.3-1.9l2.5-2.8c.5.6 1 1 1.5 1.3.5.3 1.1.5 1.7.5.7 0 1.3-.2 1.8-.7.4-.5.6-1.2.6-2.3V19.1h4v11.7c0 1.1-.1 2-.4 2.8-.3.8-.7 1.4-1.3 2-.5.5-1.2 1-2 1.2-.8.3-1.6.5-2.6.5Z"
        fill="#fff"
      />
    </svg>
  );
};
