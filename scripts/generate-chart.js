import fs from "fs";

const comparisons =
JSON.parse(
fs.readFileSync(
"_data/comparisons.json",
"utf8"
)
);

fs.mkdirSync(
"_site/assets/charts",
{
recursive:true
}
);


comparisons.forEach(item=>{

const svg=`

<svg width="500" height="300"
xmlns="http://www.w3.org/2000/svg">

<text x="20" y="30">
${item.title}
</text>

</svg>

`;

fs.writeFileSync(
`_site/assets/charts/${item.slug}.svg`,
svg
);

});
