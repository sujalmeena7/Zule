# Requirements Document

## Introduction

This feature corrects stale active-indicator ownership in the existing landing-page navbar and gives the navbar a focused premium visual treatment. The work is limited to `FloatingNavbar`, `ActiveIndicator`, `MagneticLink`, their navbar CSS, and focused automated tests. Existing landing-page structure, section anchors, download behavior, and blog routing remain unchanged.

## Glossary

- **Navbar_System**: The existing landing-page navigation composed by `FloatingNavbar`, `ActiveIndicator`, `MagneticLink`, and navbar-scoped CSS.
- **Navigation_Link**: One of Features, How it works, FAQ, or Blog in the Navbar_System.
- **Link_Group**: The desktop container that owns the Navigation_Link and CTA pointer region.
- **Hover_Target**: The Navigation_Link or CTA currently under the primary pointer.
- **Focus_Target**: The Navigation_Link or CTA currently holding keyboard focus.
- **Scroll_Active_Target**: The Navigation_Link whose landing section contains the viewport center; Blog and the CTA have no scroll-derived target.
- **Active_Target**: The target selected for the Active_Indicator, using Focus_Target or Hover_Target before Scroll_Active_Target.
- **Active_Indicator**: The visual pill positioned behind the Active_Target.
- **CTA**: The existing Get Zule action in the Navbar_System.
- **Logo_Control**: The existing Zule logo link or control in the Navbar_System.
- **Desktop_Mode**: A viewport wider than 720 CSS pixels, matching the existing navbar breakpoint.
- **Mobile_Mode**: A viewport at or below 720 CSS pixels.
- **Reduced_Motion_Mode**: A runtime state where `prefers-reduced-motion: reduce` matches.
- **Premium_Surface**: The navbar visual treatment combining translucent layers, edge definition, depth, restrained glow, and readable foreground content.

## Requirements

### Requirement 1: Immediate interaction ownership

**User Story:** As a visitor moving across navbar links, I want the indicator to belong to the link under my pointer immediately, so that the navbar never appears stuck on a previous item.

#### Acceptance Criteria

1. WHEN the pointer enters a Navigation_Link or CTA, THE Navbar_System SHALL set the Hover_Target to that element before the next browser paint.
2. WHILE a Hover_Target exists, THE Navbar_System SHALL set the Active_Target to the Hover_Target regardless of Scroll_Active_Target updates.
3. WHEN the pointer transfers between two elements inside the Link_Group, THE Navbar_System SHALL replace the Hover_Target without an intermediate Active_Target fallback.
4. WHEN the pointer leaves the Link_Group, THE Navbar_System SHALL clear the Hover_Target and set the Active_Target to the Scroll_Active_Target before the next browser paint.
5. IF the Link_Group has no Hover_Target, no Focus_Target, and no Scroll_Active_Target, THEN THE Navbar_System SHALL hide the Active_Indicator.
6. WHILE a Focus_Target exists, THE Navbar_System SHALL set the Active_Target to the Focus_Target.

### Requirement 2: Indicator geometry and motion

**User Story:** As a visitor, I want the indicator to track every label accurately and responsively, so that each transition feels intentional rather than delayed.

#### Acceptance Criteria

1. WHEN the Active_Target changes, THE Active_Indicator SHALL begin moving toward the new target before the next browser paint.
2. WHEN the Active_Target changes in Desktop_Mode, THE Active_Indicator SHALL settle on the target within 180 milliseconds.
3. WHILE the Active_Indicator is settled, THE Active_Indicator SHALL match the target element's left offset and width within 1 CSS pixel.
4. WHEN the Active_Target changes between labels of different widths, THE Active_Indicator SHALL interpolate position, width, or both before settling on the complete target geometry.
5. WHEN the pointer crosses three or more Link_Group elements before an indicator transition completes, THE Active_Indicator SHALL converge on the most recent Active_Target without rendering an intermediate fallback target.
6. WHEN the navbar compaction state, viewport size, label font metrics, or target geometry changes, THE Navbar_System SHALL remeasure the Active_Target before the next indicator transition.
7. WHILE the Active_Indicator interpolates, THE Navbar_System SHALL keep Navigation_Link text stationary except for the existing bounded Magnetic_Link response.

### Requirement 3: Premium navbar surface

**User Story:** As a visitor, I want the navbar to look refined and distinctive, so that the landing page communicates a premium product.

#### Acceptance Criteria

1. THE Navbar_System SHALL render a Premium_Surface with at least two visually distinct translucent layers.
2. THE Premium_Surface SHALL apply backdrop blur between 18 and 28 CSS pixels in environments that support backdrop filtering.
3. THE Premium_Surface SHALL provide a visible one-pixel edge treatment and separate ambient and directional depth shadows.
4. THE Navbar_System SHALL apply restrained teal, indigo, or pink glow accents drawn from the existing landing color system.
5. THE Active_Indicator SHALL render a luminous translucent fill, a defined edge, and an inset highlight without obscuring link text.
6. IF native backdrop filtering is unavailable, THEN THE Premium_Surface SHALL automatically apply an opaque fallback that preserves readable foreground contrast.

### Requirement 4: Refined component states

**User Story:** As a visitor, I want every navbar control to respond consistently, so that the visual polish extends beyond the active pill.

#### Acceptance Criteria

1. WHEN a Navigation_Link becomes the Active_Target, THE Navbar_System SHALL render the link text with a distinct high-emphasis state.
2. WHEN a Navigation_Link is neither active nor focused, THE Navbar_System SHALL render the link text with a readable low-emphasis state.
3. WHEN the Logo_Control is hovered or focused, THE Navbar_System SHALL apply at least one brand-glow or edge-highlight state.
4. WHEN the CTA is hovered or focused, THE Navbar_System SHALL apply a defined elevation, highlight, and glow state.
5. WHILE the CTA is idle, THE Navbar_System SHALL keep the CTA visually distinct from Navigation_Link elements.
6. WHEN pointer or keyboard interaction ends, THE Navbar_System SHALL return each control to the correct Active_Target or idle state without retaining stale hover styling.

### Requirement 5: Responsive and mobile behavior

**User Story:** As a visitor on a narrow viewport or touch device, I want a compact navbar that remains usable, so that premium styling does not reduce access to primary actions.

#### Acceptance Criteria

1. WHILE Mobile_Mode is active, THE Navbar_System SHALL display the Logo_Control and CTA without horizontal viewport overflow.
2. WHILE Mobile_Mode is active, THE Navbar_System SHALL preserve the existing behavior that hides the desktop Navigation_Link elements.
3. WHILE Mobile_Mode is active, THE Navbar_System SHALL hide the Active_Indicator for hidden Navigation_Link elements.
4. WHEN the viewport enters Desktop_Mode, THE Navbar_System SHALL immediately display Features, How it works, FAQ, Blog, the Logo_Control, and the CTA.
5. WHEN the viewport crosses the 720 CSS pixel breakpoint, THE Navbar_System SHALL update control visibility and indicator geometry without leaving a stale Active_Indicator.
6. WHILE the primary input does not support hover, THE Navbar_System SHALL omit pointer-magnetic feedback while preserving activation and focus behavior.

### Requirement 6: Keyboard and contrast accessibility

**User Story:** As a keyboard or low-vision visitor, I want equivalent navigation feedback and readable controls, so that the polished navbar remains accessible.

#### Acceptance Criteria

1. WHEN a Navigation_Link or CTA receives keyboard focus, THE Navbar_System SHALL position the Active_Indicator on the Focus_Target before the next browser paint.
2. WHEN focus leaves the Link_Group, THE Navbar_System SHALL restore the Active_Indicator to the Hover_Target or Scroll_Active_Target before the next browser paint.
3. THE Navbar_System SHALL provide a visible focus indicator for every interactive control.
4. THE Navbar_System SHALL render normal-sized link and CTA text with a contrast ratio of at least 4.5:1 against each applicable navbar background state.
5. THE Navbar_System SHALL render focus boundaries and non-text control-state indicators with a contrast ratio of at least 3:1 against adjacent colors.
6. WHEN Enter or Space activates a focused navbar control according to native element semantics, THE Navbar_System SHALL invoke the same destination or callback as pointer activation.

### Requirement 7: Reduced motion

**User Story:** As a visitor who prefers reduced motion, I want immediate state feedback without animated travel, so that the navbar remains comfortable and predictable.

#### Acceptance Criteria

1. WHILE Reduced_Motion_Mode is active, THE Active_Indicator SHALL update position and width without interpolation.
2. WHILE Reduced_Motion_Mode is active, THE Magnetic_Link SHALL remain at zero pointer-driven translation.
3. WHILE Reduced_Motion_Mode is active, THE Logo_Control and CTA SHALL omit decorative transform animation.
4. WHILE Reduced_Motion_Mode is active, THE Navbar_System SHALL preserve color, contrast, focus, Hover_Target, Focus_Target, and Scroll_Active_Target feedback.

### Requirement 8: Preservation and regression safety

**User Story:** As a visitor and maintainer, I want the navbar polish to preserve established behavior, so that a focused visual fix does not disrupt the landing page.

#### Acceptance Criteria

1. WHEN Features, How it works, or FAQ is activated, THE Navbar_System SHALL invoke the existing anchor callback with `features`, `how-it-works`, or `faq` respectively.
2. WHEN Blog is activated, THE Navbar_System SHALL invoke the existing blog navigation callback.
3. WHEN the CTA is activated, THE Navbar_System SHALL invoke the existing download callback.
4. THE Navbar_System SHALL preserve the existing expanded-to-compact navbar behavior at the hero boundary.
5. THE Navbar_System SHALL preserve the existing Magnetic_Link displacement vector with a magnitude no greater than 12 CSS pixels outside Reduced_Motion_Mode, including positive and negative axis components.
6. THE Navbar_System SHALL preserve the existing landing-page component hierarchy outside the navbar integration boundary.
7. THE Navbar_System SHALL limit visual and behavioral changes to navbar components, navbar-scoped styles, and focused navbar tests.
8. WHEN the focused navbar automated test suite executes, THE Navbar_System SHALL pass ownership, geometry, rapid-transfer, pointer-leave, keyboard, responsive, reduced-motion, routing, and accessibility assertions.