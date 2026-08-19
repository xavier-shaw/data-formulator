# Copyright (c) Microsoft Corporation.
# Licensed under the MIT License.

"""
Sample datasets configuration for Data Formulator.
"""

EXAMPLE_DATASETS = [
    {
        'source': 'vegadatasets',
        'name': 'Movies',
        'description': 'Box office performance, budgets, and ratings for films across different genres and time periods.',
        'tables': [
            {
                "format": 'json',
                "url": 'https://raw.githubusercontent.com/vega/vega-datasets/refs/heads/main/data/movies.json',
                "sample": [
    {"Title": "The Land Girls", "US Gross": 146083, "Worldwide Gross": 146083, "US DVD Sales": None, "Production Budget": 8000000, "Release Date": "Jun 12 1998", "MPAA Rating": "R", "Running Time min": None, "Distributor": "Gramercy", "Source": None, "Major Genre": None, "Creative Type": None, "Director": None, "Rotten Tomatoes Rating": None, "IMDB Rating": 6.1, "IMDB Votes": 1071},
    {"Title": "First Love, Last Rites", "US Gross": 10876, "Worldwide Gross": 10876, "US DVD Sales": None, "Production Budget": 300000, "Release Date": "Aug 07 1998", "MPAA Rating": "R", "Running Time min": None, "Distributor": "Strand", "Source": None, "Major Genre": "Drama", "Creative Type": None, "Director": None, "Rotten Tomatoes Rating": None, "IMDB Rating": 6.9, "IMDB Votes": 207},
    {"Title": "I Married a Strange Person", "US Gross": 203134, "Worldwide Gross": 203134, "US DVD Sales": None, "Production Budget": 250000, "Release Date": "Aug 28 1998", "MPAA Rating": None, "Running Time min": None, "Distributor": "Lionsgate", "Source": None, "Major Genre": "Comedy", "Creative Type": None, "Director": None, "Rotten Tomatoes Rating": None, "IMDB Rating": 6.8, "IMDB Votes": 865},
    {"Title": "Let's Talk About Sex", "US Gross": 373615, "Worldwide Gross": 373615, "US DVD Sales": None, "Production Budget": 300000, "Release Date": "Sep 11 1998", "MPAA Rating": None, "Running Time min": None, "Distributor": "Fine Line", "Source": None, "Major Genre": "Comedy", "Creative Type": None, "Director": None, "Rotten Tomatoes Rating": 13, "IMDB Rating": None, "IMDB Votes": None},
    {"Title": "Slam", "US Gross": 1009819, "Worldwide Gross": 1087521, "US DVD Sales": None, "Production Budget": 1000000, "Release Date": "Oct 09 1998", "MPAA Rating": "R", "Running Time min": None, "Distributor": "Trimark", "Source": "Original Screenplay", "Major Genre": "Drama", "Creative Type": "Contemporary Fiction", "Director": None, "Rotten Tomatoes Rating": 62, "IMDB Rating": 3.4, "IMDB Votes": 165},
    {"Title": "Mississippi Mermaid", "US Gross": 24551, "Worldwide Gross": 2624551, "US DVD Sales": None, "Production Budget": 1600000, "Release Date": "Jan 15 1999", "MPAA Rating": None, "Running Time min": None, "Distributor": "MGM", "Source": None, "Major Genre": None, "Creative Type": None, "Director": None, "Rotten Tomatoes Rating": None, "IMDB Rating": None, "IMDB Votes": None},
    {"Title": "Following", "US Gross": 44705, "Worldwide Gross": 44705, "US DVD Sales": None, "Production Budget": 6000, "Release Date": "Apr 04 1999", "MPAA Rating": "R", "Running Time min": None, "Distributor": "Zeitgeist", "Source": None, "Major Genre": None, "Creative Type": None, "Director": "Christopher Nolan", "Rotten Tomatoes Rating": None, "IMDB Rating": 7.7, "IMDB Votes": 15133},
    {"Title": "Foolish", "US Gross": 6026908, "Worldwide Gross": 6026908, "US DVD Sales": None, "Production Budget": 1600000, "Release Date": "Apr 09 1999", "MPAA Rating": "R", "Running Time min": None, "Distributor": "Artisan", "Source": "Original Screenplay", "Major Genre": "Comedy", "Creative Type": "Contemporary Fiction", "Director": None, "Rotten Tomatoes Rating": None, "IMDB Rating": 3.8, "IMDB Votes": 353},
    {"Title": "Pirates", "US Gross": 1641825, "Worldwide Gross": 6341825, "US DVD Sales": None, "Production Budget": 40000000, "Release Date": "Jul 01 1986", "MPAA Rating": "R", "Running Time min": None, "Distributor": None, "Source": None, "Major Genre": None, "Creative Type": None, "Director": "Roman Polanski", "Rotten Tomatoes Rating": 25, "IMDB Rating": 5.8, "IMDB Votes": 3275},
    {"Title": "Duel in the Sun", "US Gross": 20400000, "Worldwide Gross": 20400000, "US DVD Sales": None, "Production Budget": 6000000, "Release Date": "Dec 31 2046", "MPAA Rating": None, "Running Time min": None, "Distributor": None, "Source": None, "Major Genre": None, "Creative Type": None, "Director": None, "Rotten Tomatoes Rating": 86, "IMDB Rating": 7, "IMDB Votes": 2906},
    {"Title": "Tom Jones", "US Gross": 37600000, "Worldwide Gross": 37600000, "US DVD Sales": None, "Production Budget": 1000000, "Release Date": "Oct 07 1963", "MPAA Rating": None, "Running Time min": None, "Distributor": None, "Source": None, "Major Genre": None, "Creative Type": None, "Director": None, "Rotten Tomatoes Rating": 81, "IMDB Rating": 7, "IMDB Votes": 4035}
]
            }
        ]
    },
    {
        'source': 'tidytuesday',
        'name': 'College Majors',
        'description': 'A dataset of college majors and their related fields',
        'tables': [
            {
                "format": 'csv',
                "url": 'https://raw.githubusercontent.com/rfordatascience/tidytuesday/refs/heads/main/data/2018/2018-10-16/recent-grads.csv',
                "sample":  '''Rank,Major_code,Major,Total,Men,Women,Major_category,ShareWomen,Sample_size,Employed,Full_time,Part_time,Full_time_year_round,Unemployed,Unemployment_rate,Median,P25th,P75th,College_jobs,Non_college_jobs,Low_wage_jobs
1,2419,PETROLEUM ENGINEERING,2339,2057,282,Engineering,0.120564344,36,1976,1849,270,1207,37,0.018380527,110000,95000,125000,1534,364,193
2,2416,MINING AND MINERAL ENGINEERING,756,679,77,Engineering,0.101851852,7,640,556,170,388,85,0.117241379,75000,55000,90000,350,257,50
3,2415,METALLURGICAL ENGINEERING,856,725,131,Engineering,0.153037383,3,648,558,133,340,16,0.024096386,73000,50000,105000,456,176,0
4,2417,NAVAL ARCHITECTURE AND MARINE ENGINEERING,1258,1123,135,Engineering,0.107313196,16,758,1069,150,692,40,0.050125313,70000,43000,80000,529,102,0
5,2405,CHEMICAL ENGINEERING,32260,21239,11021,Engineering,0.341630502,289,25694,23170,5180,16697,1672,0.061097712,65000,50000,75000,18314,4440,972
6,2418,NUCLEAR ENGINEERING,2573,2200,373,Engineering,0.144966965,17,1857,2038,264,1449,400,0.177226407,65000,50000,102000,1142,657,244
7,6202,ACTUARIAL SCIENCE,3777,2110,1667,Business,0.441355573,51,2912,2924,296,2482,308,0.095652174,62000,53000,72000,1768,314,259
8,5001,ASTRONOMY AND ASTROPHYSICS,1792,832,960,Physical Sciences,0.535714286,10,1526,1085,553,827,33,0.021167415,62000,31500,109000,972,500,220
9,2414,MECHANICAL ENGINEERING,91227,80320,10907,Engineering,0.119558903,1029,76442,71298,13101,54639,4650,0.057342278,60000,48000,70000,52844,16384,3253
10,2408,ELECTRICAL ENGINEERING,81527,65511,16016,Engineering,0.196450256,631,61928,55450,12695,41413,3895,0.059173845,60000,45000,72000,45829,10874,3170
11,2407,COMPUTER ENGINEERING,41542,33258,8284,Engineering,0.199412643,399,32506,30315,5146,23621,2275,0.065409275,60000,45000,75000,23694,5721,980'''
            }
        ]
    },
    {
        'source': 'tidytuesday',
        'name': 'Weekly Gas Price',
        'description': 'Weekly gas prices in US for different grades and formulations',
        'tables': [
            {
                "format": 'csv',
                "url": 'https://raw.githubusercontent.com/rfordatascience/tidytuesday/refs/heads/main/data/2025/2025-07-01/weekly_gas_prices.csv',
                "sample": '''date,fuel,grade,formulation,price
1990-08-20,gasoline,regular,all,1.191
1990-08-27,gasoline,regular,all,1.245
1990-08-27,gasoline,regular,conventional,1.245
1990-09-03,gasoline,regular,all,1.242
1990-09-03,gasoline,regular,conventional,1.242
1990-09-10,gasoline,regular,all,1.252
1990-09-10,gasoline,regular,conventional,1.252
1990-09-17,gasoline,regular,all,1.266
1990-09-17,gasoline,regular,conventional,1.266
1990-09-24,gasoline,regular,all,1.272
1990-09-24,gasoline,regular,conventional,1.272
1990-10-01,gasoline,regular,all,1.321
1990-10-01,gasoline,regular,conventional,1.321
1990-10-08,gasoline,regular,all,1.333
1990-10-08,gasoline,regular,conventional,1.333
1990-10-15,gasoline,regular,all,1.339
1990-10-15,gasoline,regular,conventional,1.339'''
            }
        ]
    },
    {
        'source': 'tidytuesday',
        'name': 'Billboard Hot 100',
        'description': 'Data about every song to ever top the Billboard Hot 100 between August 4, 1958 and January 11, 2025. It was compiled by Chris Dalla Riva as he wrote the book Uncharted Territory: What Numbers Tell Us about the Biggest Hit Songs and Ourselves.',
        'tables': [   
            {
                "format": 'csv',
                'url': 'https://raw.githubusercontent.com/rfordatascience/tidytuesday/refs/heads/main/data/2025/2025-08-26/billboard.csv',
                'sample': '''song,artist,date,weeks_at_number_one,non_consecutive,rating_1,rating_2,rating_3,overall_rating,divisiveness,label,parent_label,cdr_genre,cdr_style,discogs_genre,discogs_style,artist_structure,featured_artists,multiple_lead_vocalists,group_named_after_non_lead_singer,talent_contestant,posthumous,artist_place_of_origin,front_person_age,artist_male,artist_white,artist_black,songwriters,songwriters_w_o_interpolation_sample_credits,songwriter_male,songwriter_white,artist_is_a_songwriter,artist_is_only_songwriter,producers,producer_male,producer_white,artist_is_a_producer,artist_is_only_producer,songwriter_is_a_producer,time_signature,keys,simplified_key,bpm,energy,danceability,happiness,loudness_d_b,acousticness,vocally_based,bass_based,guitar_based,piano_keyboard_based,orchestral_strings,horns_winds,accordion,banjo,bongos,clarinet,cowbell,falsetto_vocal,flute_piccolo,handclaps_snaps,harmonica,human_whistling,kazoo,mandolin,pedal_lap_steel,ocarina,saxophone,sitar,trumpet,ukulele,violin,sound_effects,song_structure,rap_verse_in_a_non_rap_song,length_sec,instrumental,instrumental_length_sec,intro_length_sec,vocal_introduction,free_time_vocal_introduction,fade_out,live,cover,sample,interpolation,inspired_by_a_different_song,lyrics,lyrical_topic,lyrical_narrative,spoken_word,explicit,foreign_language,written_for_a_play,featured_in_a_then_contemporary_play,written_for_a_film,featured_in_a_then_contemporary_film,written_for_a_t_v_show,featured_in_a_then_contemporary_t_v_show,associated_with_dance,topped_the_charts_by_multiple_artist,double_a_side,eurovision_entry,u_s_artwork
Poor Little Fool,Ricky Nelson,1958-08-04T00:00:00Z,2,0,4,5,3,4,1.3333333333333333,Imperial,Imperial,Pop;Rock,Acoustic Rock,Rock,Rock & Roll,1,NA,0,0,NA,0,United States,18,1,1,0,Sharon Sheeley,Sharon Sheeley,0,1,0,0,Jimmie Haskell;Ozzie Nelson;Ricky Nelson,1,1,1,0,0,4/4,C,C,155,33,54,80,-12,67,0,0,1,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,NA,A2,0,154,0,12,12,0,0,0,0,0,0,0,0,I used to play around with hearts.That hastened at my call.But when I met that little girl.I knew that I would fall.Poor little fool oh yeah.I was a fool uh huh.Oh oh poor little fool.I was a fool oh yeah.She played around and teased me.With her carefree devil eyes.She'd hold me close and kiss me.But her heart was full of lies.Poor little fool oh yeah.I was a fool uh huh.Oh oh poor little fool.I was a fool oh yeah.She told me how she cared for me.And that we'd never part.And so for the very first time.I gave away my heart.Poor little fool oh yeah.I was a fool uh huh.Oh oh poor little fool.I was a fool oh yeah.The next day she was gone.And I knew she'd lied to me.She left me with a broken heart.And won her victory.Poor little fool oh yeah.I was a fool uh huh.Oh oh poor little fool.I was a fool oh yeah.Well I'd played this game with other hearts.But I never thought I'd see.The day that someone else would play.Love's foolish game with me.Poor little fool oh yeah.I was a fool uh huh.Oh oh poor little fool.I was a fool oh yeah.Poor little fool oh yeah.I was a fool uh huh.Oh oh poor little fool.Poor little fool.,Lost Love,0,0,0,0,0,NA,0,NA,0,NA,0,0,NA,0,Cannot Locate
Nel Blu Dipinto Di Blu,Domenico Modugno,1958-08-18T00:00:00Z,5,1,7,7,5,6.333333333333333,1.3333333333333333,Decca,Decca,Pop,Vocal,"Pop;Folk, World, & Country",Vocal;Canzone Napoletana;Ballad,1,NA,0,0,NA,0,Italy,30,1,1,0,Franco Migliacci;Domenico Modugno;Mitchell Parish,Franco Migliacci;Domenico Modugno;Mitchell Parish,1,1,1,0,Unknown,NA,NA,NA,NA,0,Free;6/8;4/4,Bb,Bb,130,6,55,48,-17,98,0,0,0,1,1,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,NA,E1,0,219,0,11,40,1,1,0,0,0,0,0,0,NA,Flying;Dreaming,0,0,0,1,0,NA,0,NA,0,NA,0,0,NA,1,Cannot Locate
Little Star,The Elegants,1958-08-25T00:00:00Z,1,0,5,6,6,5.666666666666667,0.6666666666666666,Apt,ABC,Rock,Rock & Roll,Rock,Rock & Roll;Doo Wop,0,NA,0,0,NA,0,United States,17,1,1,0,Vito Picone;Arthur Venosa,Vito Picone;Arthur Venosa,1,1,1,1,Unknown,NA,NA,NA,NA,0,Free;4/4,A,A,73,40,41,70,-13,87,1,0,1,0,0,1,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,NA,D3,0,163,0,0,10,1,1,0,0,0,0,1,1,Where are you little star.Where are you.Twinkle twinkle little star.How I wonder where you are.Wish I may wish I might.Make this wish come true tonight.Searched all over for a love.You're the one I'm thinking of.Twinkle twinkle little star.How I wonder where you are.High above the clouds somewhere.Send me down a love to share.Oh there you are.High above.Oh oh God.Send me a love.Oh there you are.Lighting up the sky.I need a love.Oh me oh me oh my.Twinkle twinkle little star.How I wonder where you are.Wish I may wish I might.Make this wish come true tonight.There you are little star.,Longing for Love,0,0,0,0,0,NA,0,NA,0,NA,0,0,NA,0,Cannot Locate
It's All in the Game,Tommy Edwards,1958-09-29T00:00:00Z,6,0,3,3,7,4.333333333333333,2.6666666666666665,MGM,MGM,Pop,Vocal,Rock;Pop,Ballad;Doo Wop,1,NA,0,0,NA,0,United States,35,1,0,1,Carl Sigman;Charles G. Dawes,Carl Sigman;Charles G. Dawes,1,1,0,0,Harry Myerson,1,1,0,0,0,3/4,Eb,Eb,71,15,33,61,-18,4,1,0,0,1,1,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,NA,D1,0,156,0,0,3,0,0,0,0,0,0,1,1,Many a tear have to fall.But it's all in the game.All in the wonderful game.That we know as love.You have words with him.And your future's looking dim.But these things.Your hearts can rise above.Once in a while he will call.But it's all in the game.Soon he'll be there at your side.With a sweet bouquet.And he'll kiss your lips.And caress your waiting fingertips.And your hearts will fly.Away.Soon he'll be there at your side.With a sweet bouquet.Then he'll kiss your lips.And caress your waiting fingertips.And your hearts will fly.Away.,Love,0,0,0,0,0,NA,0,NA,0,NA,0,0,NA,0,Cannot Locate
It's Only Make Believe,Conway Twitty,1958-11-10T00:00:00Z,2,1,7,8,9,8,1.3333333333333333,MGM,MGM,Pop,Vocal,Rock,Rock & Roll;Pop Rock,1,NA,0,0,NA,0,United States,25,1,1,0,Jack Nance;Conway Twitty,Jack Nance;Conway Twitty,1,1,1,0,Jim Vienneau,1,1,0,0,0,Free;6/8,B,B,127,43,44,36,-10,86,1,0,0,1,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,NA,A3,0,134,0,0,24,1,1,0,0,0,0,0,0,People see us everywhere.They think you really care.But myself I can't deceive.I know it's only make believe.My one and only prayer.Is that someday you'll care.My hopes my dreams come true.My one and only you.No one will ever know.How much I love you so.My only prayer will be.Someday you'll care for me.But it's only make believe.My hopes my dreams come true.My life I'd give for you.My heart a wedding ring.My all my everything.My heart I can't control.You rule my very soul.My only prayer will be.Someday you'll care for me.But it's only make believe.My one and only prayer.Is that someday you'll care.My hopes my dreams come true.My one and only you.No one will ever know.How much I love you so.My prayers my hopes my schemes.You are my every dream.But it's only make believe.,Lost Love,0,0,0,0,0,NA,0,NA,0,NA,0,0,NA,0,Cannot Locate
Tom Dooley,The Kingston Trio,1958-11-17T00:00:00Z,1,0,5,5,2,4,2,Capitol,EMI,Folk/Country,Folk,"Folk, World, & Country",Folk,0,NA,0,0,NA,0,United States,24.333333333333332,1,1,0,Alan Lomax;Frank Warner,Alan Lomax;Frank Warner,1,1,0,0,Voyle Gilmore,1,1,0,0,0,4/4,E,E,126,14,63,52,-15,83,0,0,1,0,0,0,0,1,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,NA,C2,0,185,0,7,31,1,0,0,0,1,0,0,1,Throughout history there have been many songs written about the eternal triangle. This next one tells the story of Mister Grayson a beautiful woman and a condemned man named Tom Dooley. When the sun rises tomorrow Tom Dooley must hang.Hang down your head Tom Dooley.Hang down your head and cry.Hang down your head Tom Dooley.Poor boy you're bound to die.I met her on the mountain.There I took her life.Met her on the mountain.Stabbed her with my knife.Hang down your head Tom Dooley.Hang down your head and cry.Hang down your head Tom Dooley.Poor boy you're bound to die.This time tomorrow.Reckon where I'll be.Hadn't a been for Grayson.I'd a been in Tennessee.Well now boy.Hang down your head Tom Dooley.Hang down your head and cry.Hang down your head Tom Dooley.Poor boy you're bound to die.Hang down your head and try Tom Dooley.Hang down your head and cry.Hang down your head and try Tom Dooley.Poor boy you're bound to die.This time tomorrow.Reckon where I'll be.Down in some lonesome valley.Hanging from a white oak tree.Hang down your head Tom Dooley.Hang down your head and cry.Hang down your head Tom Dooley.Poor boy you're bound to die.Well now boy.Hang down your head Tom Dooley.Hang down your head and cry.Hang down your head Tom Dooley.Poor boy you're bound to die.Poor boy you're bound to die.Poor boy you're bound to die.Poor boy you're bound to die.,Murder;Death,1,1,0,0,0,NA,0,NA,0,NA,0,0,NA,0,Cannot Locate
To Know Him is to Love Him,The Teddy Bears,1958-12-01T00:00:00Z,3,0,8,8,8,8,0,Dore,Dore,Pop,Vocal,Pop,Vocal;Ballad,0,NA,0,0,NA,0,United States,18,2,1,0,Phil Spector,Phil Spector,1,1,1,1,Phil Spector,1,1,1,1,1,12/8,D;F,Multiple Keys,175,20,32,35,-16,89,1,0,1,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,NA,D1,0,142,0,8,8,0,0,1,0,0,0,0,0,To know know know him.Is to love love love him.Just to see him smile.Makes my life worthwhile.To know know know him.Is to love love love him.And I do.And I do and I.And I do and I.And I do and I.And I do and I.I'd be good to him.I'd bring love to him.Everyone says there'll come a day.When I'll walk along side of him.Yes yes to know him.Is to love love love him.And I do.And I do and I.And I do and I.And I do and I.And I do and I.Why can't he see.How blind can he be.Someday he will see that he.Was meant for me.Oh oh yes.To know know know him.Is to love love love him.Just to see him smile.Makes my life worthwhile.To know know know him.Is to love love love him.And I do.And I do and I.And I do and I.And I do and I.And I do and I.,Longing for Love,0,0,0,0,0,NA,0,NA,0,NA,0,0,NA,0,Cannot Locate
The Chipmunk Song,The Chipmunks,1958-12-22T00:00:00Z,4,0,1,5,2,2.6666666666666665,2.6666666666666665,Liberty,Liberty,Pop,Novelty;Holiday,Pop;Children's,Novelty,0,NA,0,0,NA,0,United States,39,1,0,0,Ross Bagdasarian Sr.,Ross Bagdasarian Sr.,1,0,1,1,Ross Bagdasarian Sr.,1,0,1,1,1,3/4,Ab;Bb&%,Ab,153,37,61,78,-12,71,0,0,1,0,0,1,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,NA,A2,0,141,0,28,19,0,0,1,0,0,0,0,0,Alright you Chipmunks Ready to sing your song.I'd say we are.Yeah Lets sing it now.Okay Simon.Okay.Okay Theodore.Okay.Okay Alvin Alvin Alvin.Okay.Christmas Christmas time is near.Time for toys and time for cheer.We've been good but we can't last.Hurry Christmas hurry fast.Want a plane that loops the loop.Me I want a Hula-Hoop.We can hardly stand the wait.Please Christmas don't be late.Ok Fellas Get ready.That was very good Simon.Naturally.Very Good Theodore.He He He He.Uh Alvin You were a little flat.Watch it Alvin Alvin Alvin.Okay.Want a plane that loops the loop.I still want a Hula-Hoop.We can hardly stand the wait.Please Christmas don't be late.We can hardly stand the wait.Please Christmas don't be late.,Christmas,0,0,0,0,0,NA,0,NA,0,NA,0,0,NA,0,Cannot Locate
Smoke Gets in Your Eyes,The Platters,1959-01-19T00:00:00Z,3,0,9,9,8,8.666666666666666,0.6666666666666666,Mercury,Mercury,Pop,Vocal,Funk/Soul,Rhythm & Blues,0,NA,0,0,NA,0,United States,30,2,0,1,Otto Harbach;Jerome Kern,Otto Harbach;Jerome Kern,1,1,0,0,Buck Ram,1,1,0,0,0,4/4,Eb;B,Multiple Keys,113,27,32,26,-11,93,1,0,0,0,1,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,NA,D1,0,158,0,16,8,0,0,0,0,1,0,0,1,They asked me how I knew.My true love was true.I of course replied.Something here inside.Cannot be denied.They said someday you'll find.All who love are blind.When your heart's on fire.You must realize.Smoke gets in your eyes.So I chaffed them and I gaily laughed.To think they could doubt my love.And yet today my love has flown away.I am without my love.Now laughing friends deride.Tears I cannot hide.So I smile and say.When a lovely flame dies.Smoke gets in your eyes.Smoke gets in your eyes.,Lost Love,0,0,0,0,1,NA,0,NA,0,NA,0,0,NA,0,Cannot Locate
Stagger Lee,Lloyd Price,1959-02-02T00:00:00Z,4,0,6,6,9,7,2,ABC-Paramount,ABC,Rock,Rhythm & Blues,Rock,Rock & Roll,1,NA,0,0,NA,0,United States,25,1,0,1,Lloyd Price;Harold Logan,Lloyd Price;Harold Logan,1,0,1,0,Don Costa,1,1,0,0,0,Free;4/4,Eb,Eb,71,62,36,79,-8,74,0,0,1,0,0,1,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,NA,A4,0,145,0,32,13,1,1,1,0,1,0,0,1,The night was clear.And the moon was yellow.And the leaves came tumbling down.I was standing on the corner.When I heard my bulldog bark.He was barking at the two men.Who were gambling in the dark.It was Stagger Lee and Billy.Two men who gambled late.Stagger Lee threw seven.Billy swore that he threw eight.Stagger Lee told Billy.I can't let you go with that.You have won all my money.And my brand new Stetson hat.Stagger Lee started off.Going down that railroad track.He said I can't get you Billy.But don't be here when I come back.Go on Stagger Lee.Stagger Lee went home.And he got his forty-four.Said I'm going to the bar room.Just to pay that debt I owe.Stagger Lee went to the bar room.And he stood across the bar room door.Said Now nobody move.And he pulled his forty-four.Stagger Lee cried Billy.Oh please don't take my life.I got three little children.And a very sickly wife.Stagger Lee shot Billy.Oh he shot that poor boy so bad.Till the bullet came through Billy.And it broke the bartender's glass.Now look out Stagg come on.,Murder;Death,1,0,0,0,0,NA,0,NA,0,NA,0,0,NA,0,Cannot Locate
Venus,Frankie Avalon,1959-03-09T00:00:00Z,5,0,3,2,2,2.3333333333333335,0.6666666666666666,Chancellor,ABC,Pop,Vocal,Pop,Vocal,1,NA,0,0,NA,0,United States,18,1,1,0,Ed Marshall,Ed Marshall,1,1,0,0,Peter DeAngelis;Bob Marcucci,1,1,0,0,0,4/4,Bb,Bb,115,48,56,75,-10,73,1,0,1,1,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,NA,D1,0,142,0,23,16,0,0,0,0,0,0,0,0,Venus.Venus.Venus if you will.Please send a little girl for me to thrill.A girl who wants my kisses and my arms.A girl with all the charms of you.Venus make her fair.A lovely girl with sunlight in her hair.And take the brightest stars up in the skies.And place them in her eyes for me.Venus goddess of love that you are.Surely the things I ask.Can't be too great a task.Venus if you do.I promise that I always will be true.I'll give her all the love I have to give.As long as we both shall live.Venus goddess of love that you are.Surely the things I ask.Can't be too great a task.Venus if you do.I promise that I always will be true.I'll give her all the love I have to give.As long as we both shall live.Venus.Venus.Make my wish come true.,Longing for Love,0,0,0,0,0,NA,0,NA,0,NA,0,0,NA,0,Artist Photograph'''
            }
        ]
    },
    {
        'source': 'df-study',
        'name': 'Health Spending',
        'description': 'Global health spending estimates for 216 locations (countries, GBD super regions, World Bank income groups, and global) from 1995-2022 — total (THE), government (GHES), prepaid private (PPP), out-of-pocket (OOP), and development-assistance (DAH) expenditure, each given in absolute, per-capita, share-of-total, and share-of-GDP terms. Point estimates only; the uncertainty bounds of the full dataset are dropped.',
        'tables': [
            {'format': 'csv', 'path': 'example_datasets/health_spending.csv'},
        ]
    },
    {
        'source': 'df-study',
        'name': 'FAA Wildlife Strikes',
        'description': 'FAA reports of wildlife strikes on aircraft (mostly birds) from 1990-2026, with incident date and time of day, airport and coordinates, state, operator, aircraft type/class/mass, engine type and count, flight phase, height, speed, distance, sky and precipitation conditions, damage severity (Minor / Substantial / Destroyed / Undetermined), and the species, size, and number of animals struck.',
        'tables': [
            {'format': 'csv', 'path': 'example_datasets/faa_damage.csv'},
        ]
    },
]
