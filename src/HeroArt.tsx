import {useId} from 'react';

/** Remove the original image's light matte before compositing, rather than
 * relying on a screen blend layer that can flash black during mobile motion. */
export function HeroArt(){
  const filterId=useId();
  return <div className="hero-art" role="img" aria-label="Anonymous figure wearing a hat and sunglasses, working at a laptop">
    <svg viewBox="0 0 500 500" width="500" height="500" aria-hidden="true" focusable="false">
      <defs><filter id={filterId} colorInterpolationFilters="sRGB" x="0" y="0" width="100%" height="100%">
        <feColorMatrix type="matrix" values="0 0 0 0 1  0 0 0 0 1  0 0 0 0 1  -0.4252 -1.4304 -0.1444 0 1.5"/>
      </filter></defs>
      <image href="/anonymous-logo.png" width="500" height="500" filter={`url(#${filterId})`}/>
    </svg>
  </div>;
}
