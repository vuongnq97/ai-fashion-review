# /tfood FIX SPEC --- BACKGROUND DNA + DYNAMIC FOOD AFFORDANCE ENGINE

## AI Coding Agent Implementation Specification --- v3

# 0. Problems to fix

The current `/tfood` architecture has three systemic problems:

1.  Background is too generic.
    `wooden table + cozy home + warm daylight` produces stock-food
    imagery rather than the layered, lived-in food-review world of the
    reference channels.
2.  Hero Interaction is too generic. Scene 3 must not imply that every
    food should be broken, squeezed, crushed, torn, or dipped.

This spec intentionally does NOT prescribe any Start Frame splitting,
aspect-ratio, independent-frame, or contact-sheet architecture. That
concern is handled by a separate solution.

This must be an architectural fix for background and product-specific
food interactions, not a one-product patch.

# 1. New architecture

``` text
PRODUCT REFERENCES + METADATA
→ REFERENCE ROLE CLASSIFICATION
→ FOOD PHYSICAL PROFILE
→ SENSORY EVIDENCE PLAN
→ AFFORDANCE + FORBIDDEN ACTIONS
→ PRODUCT STATE MACHINE
→ FOOD REVIEW WORLD + PROP PLAN
→ DYNAMIC 4-SCENE PLAN
→ SHOW→SAY SCRIPT
→ HARD QA
→ 4 × 6s I2V
→ 24s FINAL VIDEO
```

Keep the semantic phases:

``` text
Discovery → Show → Experience → Verdict
```

but DO NOT map them to fixed physical actions.

# 4. Food Review World Bible

Replace generic environment instructions with a persistent channel
world:

``` json
{
  "foodReviewWorld": {
    "environment": "lived-in Vietnamese home dining / snack-review corner",
    "surface": "warm natural wooden table with visible grain",
    "lighting": "soft side-window daylight, warm-neutral, natural falloff",
    "cameraLook": "real smartphone food review, handheld authenticity",
    "depth": "foreground product sharp, background softly readable and naturally blurred",
    "propDensity": "medium",
    "forbiddenLook": [
      "empty studio table",
      "luxury restaurant plating",
      "commercial catalogue backdrop",
      "CGI kitchen",
      "overdecorated influencer set",
      "sterile seamless background"
    ]
  }
}
```

The desired visual DNA is:

``` text
warm
domestic
layered
textured
food-centered
real smartphone
slightly imperfect
```

Every frame should reason in layers:

``` text
FOREGROUND: food / hand / spoon / package action
MIDGROUND: plate / bowl / serving vessel / package
BACKGROUND: tea cup / plant / flowers / chair / domestic cues
```

Do not insert every prop into every scene. Select 2--4 relevant props.

Examples:

``` text
dried snack → tea cup + serving plate + package
ready-to-eat savory food → rice bowl + ceramic dish + package
pastry → tea + small flowers + serving tray
drink → glass + package/bottle + valid context cue
```

Lock across all four scenes:

``` text
table color/species
light direction
color temperature
room style
prop family
reviewer hand appearance
```

# 5. Food Physical Profile --- mandatory new module

Before scene generation, infer:

``` json
{
  "foodPhysicalProfile": {
    "form": "",
    "unitScale": "",
    "cohesion": "",
    "hardness": "",
    "brittleness": "",
    "viscosity": "",
    "hasInteriorReveal": false,
    "hasFilling": false,
    "hasShell": false,
    "isPourable": false,
    "isScoopable": false,
    "isSpreadable": false,
    "isDippable": false,
    "isBreakableByHand": false,
    "isTearableByHand": false,
    "isSqueezableMeaningfully": false,
    "servedWith": [],
    "scaleCueNeeded": true
  }
}
```

Minimum form taxonomy:

``` text
whole_small_unit
whole_medium_unit
bar_block
slice
filled_pastry
crispy_sheet
dried_strip
shredded_food
granular_food
paste
sauce
spread
powder
liquid
jelly
noodle
rice_topping
mixed_snack
fresh_fruit
dried_fruit
nuts_seeds
candy
```

Unit scale:

``` text
tiny | small | medium | large | bulk | liquid
```

Reference pixels override generic category assumptions.

# 6. Affordance Engine

Generate:

``` json
{
  "affordance": {
    "recommendedActions": [],
    "allowedActions": [],
    "forbiddenActions": [],
    "heroAction": "",
    "heroActionReason": "",
    "sensoryEvidence": ""
  }
}
```

Core rule:

> Hero Interaction is the most visually informative, physically
> plausible action for the exact product. It is NOT synonymous with
> breaking the food.

Candidate actions may include:

``` text
open
pour
scoop
lift
dip
spread
stir
shake
rotate
pick
show_scale
show_handful
stack
crack
break
tear
pull
peel
slice
press
drizzle
mix_with_rice
compare_quantity
```

# 7. Break / squeeze rules

`break` is valid only when:

``` text
meaningful interior exists
AND product is large enough to grip
AND breaking is natural consumer behavior
AND breaking reveals useful sensory evidence
```

Examples:

``` text
bánh pía              YES
filled cookie         YES
large crispy cake     MAYBE
tiny coated peanut    NO
seed                   NO
sauce                  NO
shredded meat         NO
drink                  NO
```

`squeeze` is valid only when deformation itself proves a meaningful
quality, e.g. mochi, sponge cake, soft bread.

Do not default to squeeze for nuts, crispy snacks, hard candy, powders,
sauces, jar food, or tiny pellets.

# 8. Tiny-food override

For:

``` text
nuts
seeds
coated peanuts
small candy
small cereal pieces
tiny dried snacks
```

do not default to:

``` text
break
tear
squeeze
crush
```

Prefer:

``` text
pick one unit between fingertips
rotate under light
show fingertip scale
pour a small handful
let pieces fall into palm or plate
show coating in macro
show quantity / abundance
```

Pseudo:

``` ts
if (profile.unitScale === "tiny") {
  disable("tear");
  stronglyPenalize("break");
  disable("squeeze");
  boost("pick");
  boost("rotate");
  boost("pour");
  boost("show_handful");
}
```

# 9. Example --- coated peanut

BAD:

``` text
hold one peanut
→ dramatically break it in half
→ squeeze/crush it
```

GOOD:

``` text
Scene 1 Discovery:
show pouch + quantity

Scene 2 Show:
pour a handful into palm or ceramic plate;
macro the coating and uniform size

Scene 3 Experience:
pick one peanut between thumb/index finger;
slowly rotate it near camera;
show scale and surface;
optionally let several pieces fall into palm/plate

Scene 4 Verdict:
handful/spoonful near camera;
package softly visible behind;
show abundance + snack context
```

Sensory evidence:

``` text
coating
uniformity
size
quantity
surface texture
```

No forced interior reveal.

# 10. Example --- mắm tép

Physical profile:

``` text
shredded/granular savory topping
scoopable
spreadable
bulk
no meaningful hand-break
```

Correct state progression:

``` text
sealed jar
→ opened jar / texture
→ spoonful lifted
→ served over hot rice
```

Forbidden:

``` text
rectangular chunk
both hands breaking it
cracking a crust
```

# 11. Other examples

Filled pastry:

``` text
break/pull-apart/show filling
```

Dried sweet-potato strip:

``` text
bend/pull/tear slowly to show fibrous sticky texture
```

Dried fish:

``` text
lift/dip/raise toward camera
```

Drink:

``` text
open/pour/show flow/swirl/lift glass
```

Sauce/paste:

``` text
scoop/spread/drizzle/pour if physically valid
```

# 12. Evidence-first planning

Do not select an action merely because it looks dynamic.

Use:

``` text
desired sensory evidence
→ physically valid action that reveals it
```

Examples:

``` text
filling → break pastry
coating → rotate/pour tiny nut
viscosity → scoop/pour sauce
fibers → tear dried sweet potato
flow → pour drink
```

Pseudo:

``` ts
function chooseHeroAction(profile, refs) {
  const candidates = derivePhysicallyValidActions(profile);

  return maxValid(candidates.map(action => ({
    action,
    score:
      sensoryEvidenceScore(action, profile) +
      visualClarityScore(action) +
      consumerNaturalnessScore(action, profile) +
      referenceSupportScore(action, refs) +
      videoMotionScore(action) -
      mutationRisk(action, profile) -
      anatomyRisk(action)
  })));
}
```

# 13. Dynamic 4-scene planner

The four phases are semantic purposes only.

Scene 1 --- Discovery can choose:

``` text
package reveal
quantity reveal
delivery/authenticity cue
open container
first look
```

Scene 2 --- Show chooses the best evidence:

``` text
surface
size
quantity
coating
color
consistency
packaging
portion
flow
```

Scene 3 --- Experience chooses ONE best affordance.

Scene 4 --- Verdict shows the most useful final evidence state:

``` text
served state
spoonful
handful
opened interior
dipped piece
glass
rice pairing
plate abundance
```

Remove any global rule equivalent to:

``` text
Scene 2 always holds one piece
Scene 3 always breaks/dips
Scene 3 always uses both hands
Scene 4 always shows interior
```

# 14. Product State Machine

Add:

``` json
{
  "productStates": {
    "initial": "",
    "scene1End": "",
    "scene2End": "",
    "scene3End": "",
    "scene4End": ""
  }
}
```

Hard reject mutations:

``` text
paste → cake
shredded meat → crispy bar
peanut → filled cookie
dried fruit → pastry
```

# 15. Product-specific Action Runway

Remove universal wording like:

``` text
both hands firmly positioned
fingers gripping firmly
tension on food
ready to reveal
```

Use action-specific runway:

``` text
scoop:
spoon already inside/under product; receiving bowl positioned

pour:
package/glass slightly tilted; receiving vessel positioned

break:
ONLY valid breakable food; hands placed on opposite sides

pick/rotate tiny food:
one unit naturally pinched with clearance to rotate

dip:
food above sauce; wrist orientation supports downward motion
```

# 16. Dynamic texture language

Remove universal:

``` text
juicy / soft / crispy consistency
```

Generate only evidence-supported texture descriptors.

Examples:

``` text
peanut → crisp-looking dry coating
mắm tép → moist loose shredded texture
jelly → translucent soft wobble
drink → flow / viscosity / bubbles
```

# 17. Show→Say synchronization

Visual planning and dialogue planning must be linked.

Example:

Visual:

``` text
pour peanuts into palm and macro coating
```

Dialogue should discuss:

``` text
size / coating / quantity
```

It must NOT say:

``` text
"bẻ ra bên trong..."
```

if no break occurs.

Add `validateShowSaySync()`.

# 18. Reference role classification

``` json
{
  "referenceRoles": {
    "package": [],
    "foodCloseup": [],
    "serving": [],
    "interaction": [],
    "environment": []
  }
}
```

If only package imagery exists and physical behavior is uncertain,
prefer low-mutation actions and mark low confidence instead of inventing
a destructive interaction.

# 19. Confidence-aware planning

``` json
{
  "physicalProfileConfidence": 0.0,
  "heroActionConfidence": 0.0
}
```

Low confidence should boost conservative actions:

``` text
hold
rotate
open if clearly supported
pour visible units
show quantity
```

# 21. Video prompt v3

``` text
Animate this exact 9:16 Start Frame into a realistic 6-second smartphone food-review shot.

PRIMARY ACTION:
{{SCENE_ACTION}}

PRODUCT STATE TRANSITION:
{{START_STATE}} → {{END_STATE}}

HAND MOTION:
{{HAND_MOTION}}

TOOL MOTION:
{{TOOL_MOTION}}

CAMERA:
{{CAMERA_MOTION}}

SENSORY EVIDENCE TO REVEAL:
{{SENSORY_EVIDENCE}}

BACKGROUND:
Keep the same room, wooden table, lighting direction and prop family from the Start Frame.

FORBIDDEN:
{{FORBIDDEN_ACTIONS}}

Do not invent a new food form.
Do not force a break, tear, squeeze, crush or interior reveal unless explicitly listed as valid.
Keep motion natural and physically plausible.
```

# 23. QA hard gates

Before aesthetic scoring:

``` text
product form correct?
hero action physically valid?
no forbidden action?
no major hand mutation?
no baked text/UI?
```

Any failure = candidate cannot win.

Add errors:

``` text
BACKGROUND_TOO_GENERIC
BACKGROUND_WORLD_DRIFT
INVALID_FOOD_ACTION
PRODUCT_SCALE_ACTION_MISMATCH
FORCED_BREAK
FORCED_SQUEEZE
PRODUCT_FORM_MUTATION
UNSUPPORTED_INTERIOR_REVEAL
SHOW_SAY_MISMATCH
```

Suggested score:

``` text
Product fidelity              20
Physical action correctness   20
Reference-style environment   15
Sensory evidence              10
Hand/tool anatomy              8
Appetite appeal                7
Continuity                     5
TOTAL                        100
```

# 24. Real QA only

Do not emit fake fallback candidate scores when visual QA was not
actually performed.

If QA is unavailable:

``` text
QA_UNAVAILABLE
```

Then retry or require manual approval.

# 25. Migration REMOVE

Search semantically and replace:

``` text
generic Scene 2 "hold one piece"
generic Scene 3 "both hands grip with tension"
generic Scene 4 "revealed interior"
universal juicy/soft/crispy wording
forced break/tear/squeeze behavior
```

# 26. Migration ADD

Add equivalents of:

``` text
classifyReferenceRoles()
analyzeFoodPhysicalProfile()
deriveFoodAffordances()
deriveForbiddenFoodActions()
chooseHeroInteraction()
buildProductStateMachine()
buildFoodReviewWorld()
buildDynamicPropPlan()
buildDynamicFourScenePlan()
validateFoodAction()
validateBackgroundWorld()
validateShowSaySync()
```

# 27. Acceptance tests

1.  Same Food Review World is recognizable across all scenes.
2.  Tiny coated peanut defaults to pour/pick/rotate/handful rather than
    break/squeeze/crush.
3.  Filled pastry may use break/pull-apart.
4.  Sauce/paste uses scoop/spread/pour when valid.
5.  Mắm tép remains shredded/granular and follows jar→open→scoop→rice.
6.  Dialogue describes what is actually shown.
7.  Physical scale remains realistic.
8.  4×6s / 24s format remains unchanged. \# 28. Direct instruction to AI
    coding agent

Implement this as a generalized architectural correction.

DO NOT write:

``` text
if productName contains "đậu phộng" then don't break
```

Implement:

``` text
physical profile
+ unit scale
+ sensory evidence
+ affordance scoring
+ forbidden actions
+ confidence
+ product state machine
```

Core principles:

1.  Discovery / Show / Experience / Verdict are narrative roles, not
    fixed hand actions.
2.  Choose sensory evidence first, then the physical action that reveals
    it.
3.  Tiny food does not need to be broken merely because Scene 3 needs a
    Hero Interaction.
4.  Background is a persistent channel world, not a generic wooden-table
    keyword.
