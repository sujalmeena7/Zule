# Requirements Document

## Introduction

This feature enhances the existing public landing page (`src/components/LandingPage.tsx`) of the Zule application to feel professional and visually striking, with the hero section as the centerpiece. The enhancement uses a hybrid 3D strategy: CSS 3D transforms, perspective, and parallax provide a consistent depth language across the page, while a single react-three-fiber canvas renders a floating translucent geometry behind the hero headline as the visual focal point. The navbar is redesigned as a floating glassmorphic pill with magnetic interaction. Existing sections (tools ticker, How-It-Works, FAQ, footer) remain functionally unchanged but receive subtle depth polish for cohesion. All existing routing, download links, and CTA wiring must continue to work, and the page must remain accessible to users who prefer reduced motion.

## Glossary

- **Landing_Page**: The public marketing page rendered by `src/components/LandingPage.tsx`.
- **Hero_Section**: The top-most section of the Landing_Page containing the headline "#1 Undetectable AI for Meetings", subtitle, badges, and primary CTA buttons.
- **Hero_3D_Canvas**: A single react-three-fiber `<Canvas>` element rendered behind the Hero_Section headline that displays a slow-rotating translucent geometry.
- **Hero_Geometry**: The 3D mesh rendered inside the Hero_3D_Canvas, an icosahedron or torus with translucent material, refraction, chromatic aberration, and rim lighting.
- **Navbar**: The top navigation bar containing the Zule logo, navigation links (Features, How it works, FAQ, Blog), and the "Get Zule" CTA button.
- **Floating_Pill_Navbar**: The redesigned Navbar rendered as a centered, floating, glassmorphic pill that shrinks to a compact form once the user has scrolled past the Hero_Section.
- **Magnetic_Link**: A navigation link in the Floating_Pill_Navbar whose visible label translates toward the cursor when the cursor is within a defined activation radius.
- **Active_Indicator**: A visual element inside the Floating_Pill_Navbar that slides between navigation links to indicate the currently hovered or active link.
- **Polish_Sections**: The existing bento features grid, stats section, and bottom CTA section, which receive subtle CSS 3D tilt, parallax, or depth treatments.
- **Reduced_Motion_Mode**: The runtime state in which the user's operating system reports `prefers-reduced-motion: reduce`, surfaced in the app via the existing `MotionConfig reducedMotion="user"` pattern.
- **Tab_Hidden_State**: The runtime state in which `document.visibilityState` is `"hidden"`.
- **Low_End_GPU**: A rendering environment in which the browser reports a device pixel ratio greater than 1 combined with a hardware concurrency value at or below 4, or in which WebGL context creation reports a software renderer.
- **Color_System**: The existing dark theme palette with teal, indigo, and pink accents used throughout the current Landing_Page.

## Requirements

### Requirement 1: Hero 3D Centerpiece

**User Story:** As a visitor landing on the Zule home page, I want a striking 3D visual behind the headline, so that the product feels premium and distinct from typical SaaS landing pages.

#### Acceptance Criteria

1. THE Landing_Page SHALL render exactly one Hero_3D_Canvas behind the Hero_Section headline.
2. THE Hero_3D_Canvas SHALL render the Hero_Geometry as a single translucent icosahedron or torus mesh.
3. THE Hero_Geometry SHALL rotate continuously about at least one axis at a rate between 0.05 and 0.3 radians per second.
4. THE Hero_Geometry SHALL apply a translucent material with refraction, chromatic aberration, and rim lighting.
5. THE Hero_3D_Canvas SHALL be positioned behind the Hero_Section headline text such that the headline remains the foreground reading layer.
6. THE Landing_Page SHALL NOT render any additional react-three-fiber canvases outside the Hero_Section.

### Requirement 2: Hero 3D Performance and Accessibility

**User Story:** As a user on a low-end device or with reduced-motion preferences, I want the 3D hero to stay smooth or stop animating, so that the page does not drain my battery, overheat my device, or trigger motion discomfort.

#### Acceptance Criteria

1. WHILE the Tab_Hidden_State is active, THE Hero_3D_Canvas SHALL suspend its render loop.
2. WHEN the Tab_Hidden_State becomes inactive, THE Hero_3D_Canvas SHALL resume its render loop.
3. WHILE the Reduced_Motion_Mode is active, THE Hero_Geometry SHALL hold a static pose with no rotation and no animated material effects.
4. WHERE the runtime environment is detected as a Low_End_GPU, THE Hero_3D_Canvas SHALL cap its device pixel ratio at 1.
5. IF WebGL context creation fails, THEN THE Landing_Page SHALL render the Hero_Section without the Hero_3D_Canvas and without throwing a runtime error.
6. THE Hero_3D_Canvas SHALL mount lazily so that the JavaScript bundle required for `three`, `@react-three/fiber`, and `@react-three/drei` is loaded on demand rather than synchronously with the initial Landing_Page bundle.

### Requirement 3: Floating Glassmorphic Navbar

**User Story:** As a visitor, I want a modern floating navbar that adapts as I scroll, so that navigation stays accessible without dominating the page.

#### Acceptance Criteria

1. THE Floating_Pill_Navbar SHALL be horizontally centered relative to the viewport.
2. THE Floating_Pill_Navbar SHALL apply a backdrop blur of at least 12 pixels and a semi-transparent background consistent with the Color_System.
3. WHILE the vertical scroll position is at or above the bottom edge of the Hero_Section, THE Floating_Pill_Navbar SHALL render in a compact pill form with reduced height and horizontal padding compared to its initial form.
4. WHILE the vertical scroll position is below the bottom edge of the Hero_Section, THE Floating_Pill_Navbar SHALL render in its initial expanded form.
5. THE Floating_Pill_Navbar SHALL transition between its expanded and compact forms over a duration between 200 and 400 milliseconds.
6. THE Floating_Pill_Navbar SHALL contain the same navigation links and primary CTA as the existing Navbar (Features, How it works, FAQ, Blog, Get Zule).

### Requirement 4: Magnetic Navigation Links and Active Indicator

**User Story:** As a visitor exploring the navbar, I want responsive, tactile hover feedback, so that the navigation feels alive and high-quality.

#### Acceptance Criteria

1. WHEN the cursor is within a 60 pixel radius of a Magnetic_Link's center, THE Magnetic_Link SHALL translate toward the cursor by a maximum displacement of 12 pixels.
2. WHEN the cursor leaves the activation radius of a Magnetic_Link, THE Magnetic_Link SHALL return to its origin position over a duration between 150 and 350 milliseconds.
3. WHEN the cursor hovers over a navigation link in the Floating_Pill_Navbar, THE Active_Indicator SHALL slide so that its bounding box aligns with the hovered link over a duration between 200 and 400 milliseconds.
4. WHILE no navigation link is hovered, THE Active_Indicator SHALL align with the navigation link whose anchor target matches the section currently intersecting the viewport center.
5. WHILE the Reduced_Motion_Mode is active, THE Magnetic_Link SHALL NOT translate in response to cursor proximity.
6. WHILE the Reduced_Motion_Mode is active, THE Active_Indicator SHALL update its position without an animated transition.

### Requirement 5: Logo 3D Hover

**User Story:** As a visitor, I want the Zule logo in the navbar to react to hover, so that the brand feels interactive without being distracting.

#### Acceptance Criteria

1. WHEN the cursor hovers over the Zule logo in the Floating_Pill_Navbar, THE Floating_Pill_Navbar SHALL apply a CSS 3D rotation to the logo on the X and Y axes with a maximum rotation of 15 degrees per axis.
2. WHEN the cursor leaves the Zule logo, THE Floating_Pill_Navbar SHALL return the logo to a 0 degree rotation over a duration between 200 and 400 milliseconds.
3. WHILE the Reduced_Motion_Mode is active, THE Floating_Pill_Navbar SHALL NOT apply rotation to the Zule logo on hover.

### Requirement 6: Polish Section Depth

**User Story:** As a visitor scrolling the page, I want the rest of the page to feel cohesive with the hero, so that the design reads as one polished product rather than a hero bolted onto a flat page.

#### Acceptance Criteria

1. WHEN the cursor hovers over a bento card in the features grid, THE Landing_Page SHALL apply a CSS 3D tilt to that card with a maximum rotation of 8 degrees on the X and Y axes.
2. WHEN the cursor leaves a bento card, THE Landing_Page SHALL return that card to a 0 degree rotation over a duration between 200 and 400 milliseconds.
3. WHILE the user scrolls, THE Landing_Page SHALL apply a parallax translation to the stats section AnimatedMockup with a maximum displacement of 40 pixels relative to the section's natural scroll position.
4. THE Landing_Page SHALL apply a perspective container with a perspective value between 800 and 1600 pixels to the bento features grid and the bottom CTA section.
5. WHILE the Reduced_Motion_Mode is active, THE Landing_Page SHALL NOT apply hover tilt or scroll parallax to the Polish_Sections.

### Requirement 7: Unchanged Sections

**User Story:** As a visitor, I want the existing tools ticker, How-It-Works, FAQ, and footer sections to keep working the way they already do, so that the redesign does not break content I rely on.

#### Acceptance Criteria

1. THE Landing_Page SHALL retain the existing tools ticker section with its current marquee animation and brand list (Zoom, Slack, Microsoft Teams, Google Meet, Webex).
2. THE Landing_Page SHALL retain the existing How-It-Works section with its waveform animation, timer, and widget mockups.
3. THE Landing_Page SHALL retain the existing FAQ section rendered by the `FAQSection` component.
4. THE Landing_Page SHALL retain the existing footer with its product, support, legal columns and social links.
5. THE Landing_Page SHALL apply only visual consistency adjustments to the tools ticker, How-It-Works, FAQ, and footer that match the Color_System.

### Requirement 8: Routing and CTA Preservation

**User Story:** As a visitor clicking calls-to-action, I want the existing download and navigation buttons to continue working, so that the redesign does not block me from getting the product.

#### Acceptance Criteria

1. WHEN the visitor clicks the primary download button in the Hero_Section, THE Landing_Page SHALL open the GitHub releases installer URL for the detected operating system in a new browser tab.
2. WHEN the visitor clicks the "See how it works" button in the Hero_Section, THE Landing_Page SHALL invoke the existing `actions.navigateTo('dashboard')` flow.
3. WHEN the visitor clicks the "Get Zule" button in the Floating_Pill_Navbar, THE Landing_Page SHALL open the GitHub releases installer URL for the detected operating system in a new browser tab.
4. WHEN the visitor clicks the Blog link in the Floating_Pill_Navbar, THE Landing_Page SHALL invoke the existing `actions.navigateTo('blog')` flow.
5. WHEN the visitor clicks the Features, How it works, or FAQ links in the Floating_Pill_Navbar, THE Landing_Page SHALL scroll to the corresponding section anchor (`#features`, `#how-it-works`, `#faq`).
6. WHEN the visitor clicks the download button in the bottom CTA section, THE Landing_Page SHALL open the GitHub releases installer URL for the detected operating system in a new browser tab.

### Requirement 9: Electron Rendering Compatibility

**User Story:** As a user opening the Zule desktop app, I want the landing page to render correctly inside Electron, so that the redesign does not break the in-app experience.

#### Acceptance Criteria

1. THE Landing_Page SHALL render without runtime errors when loaded inside the Electron renderer process used by the Zule desktop app.
2. IF the Electron renderer reports WebGL as unavailable, THEN THE Landing_Page SHALL apply the same fallback defined in Requirement 2.5.
3. THE Landing_Page SHALL NOT load resources via absolute web-only URLs that would fail to resolve under the Electron `file://` protocol for assets already shipped with the desktop bundle.

### Requirement 10: Visual System Consistency

**User Story:** As a visitor, I want the new elements to look like they belong to Zule, so that the brand identity stays consistent.

#### Acceptance Criteria

1. THE Hero_Geometry SHALL use accent colors drawn from the Color_System's teal, indigo, and pink palette.
2. THE Floating_Pill_Navbar SHALL use background, border, and text colors drawn from the existing dark theme defined in `src/components/LandingPage.css`.
3. THE Polish_Sections SHALL retain their existing color values from `src/components/LandingPage.css` for backgrounds, text, and borders.
4. THE Landing_Page SHALL declare any new shared color or shadow tokens introduced by this feature as CSS custom properties in `src/components/LandingPage.css` or a co-located stylesheet.

### Requirement 11: Dependencies

**User Story:** As a developer maintaining the project, I want the new 3D dependencies to be explicitly declared and scoped, so that the bundle and install footprint stays predictable.

#### Acceptance Criteria

1. THE project SHALL declare `three`, `@react-three/fiber`, and `@react-three/drei` as runtime dependencies in `package.json`.
2. THE Landing_Page SHALL import `three`, `@react-three/fiber`, and `@react-three/drei` only from modules referenced by the Hero_3D_Canvas implementation.
3. THE Landing_Page SHALL NOT bundle `three`, `@react-three/fiber`, or `@react-three/drei` into the initial route chunk loaded before the Hero_3D_Canvas mounts.
